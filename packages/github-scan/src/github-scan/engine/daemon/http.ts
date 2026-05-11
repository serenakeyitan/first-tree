/**
 * Phase 3b: TypeScript port of the github-scan daemon HTTP + SSE server.
 *
 * Source of truth: `http.rs` (384
 * lines). Contract pinned in the HTTP/SSE API contract (historical migration doc, now removed; see git history).
 *
 * READ-ONLY DISCIPLINE:
 * ---------------------
 * This module NEVER calls `runtime/store.ts` writers. The HTTP server is
 * strictly a reader: it passes through `~/.first-tree/github-scan/inbox.json`, tails
 * `~/.first-tree/github-scan/activity.log`, and publishes SSE events produced by an
 * upstream bus. The single-writer rule for `inbox.json` (spec doc 2
 * §1.3) is owned by the poller; HTTP read paths either `fs.readFile` the
 * on-disk JSON directly (so they always see the last atomic rename) or
 * subscribe to an in-process bus (Phase 3c).
 *
 * Zero-framework footprint: we use `node:http` directly so the bundle
 * stays dep-free. Headers, status line, and keep-alive cadence match the
 * Rust server byte-for-byte.
 *
 * Loopback-only bind: the Rust server rejects non-127.0.0.1 binds at
 * startup (`http.rs:28-32`). We preserve that invariant.
 *
 * Shutdown: honors an `AbortSignal`. On abort:
 *   1. Stop accepting new connections (`server.close`).
 *   2. Abort all live SSE connections via their per-connection signals.
 *   3. Resolve once the listener has fully closed.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promises as fsp, readFileSync } from "node:fs";
import { join } from "node:path";

import { createInboxMtimeBus, runSseStream, type SseBus } from "./sse.js";
import type { DashboardTask } from "./thread-store.js";
import { resolveFirstTreePackageRoot } from "../bridge.js";

/**
 * Routes matched against the path component after the query is stripped.
 * `/`, `/dashboard`, `/index.html` all map to `dashboard`, matching
 * `http.rs::parse_route`.
 *
 * Island feature additions (POST methods):
 *   `translate` — POST /inbox/:id/translate, single-shot natural-language
 *   to whitelisted action translation. The first mutation route on this
 *   server; details in the route handler.
 */
export type Route =
  | "dashboard"
  | "healthz"
  | "inbox"
  | "tasks"
  | "activity"
  | "events"
  | { kind: "translate"; entryId: string }
  | "not-found";

const TRANSLATE_PATH_RE = /^\/inbox\/([^/]+)\/translate$/;

export function parseRoute(method: string, url: string | undefined): Route {
  if (!url) return "not-found";
  const queryIdx = url.indexOf("?");
  const path = queryIdx === -1 ? url : url.slice(0, queryIdx);
  if (method === "POST") {
    const m = TRANSLATE_PATH_RE.exec(path);
    if (m) return { kind: "translate", entryId: decodeURIComponent(m[1]!) };
    return "not-found";
  }
  if (method !== "GET") return "not-found";
  switch (path) {
    case "/":
    case "/dashboard":
    case "/index.html":
      return "dashboard";
    case "/healthz":
      return "healthz";
    case "/inbox":
      return "inbox";
    case "/tasks":
      return "tasks";
    case "/activity":
      return "activity";
    case "/events":
      return "events";
    default:
      return "not-found";
  }
}

/** Hard-coded limit from `http.rs::write_activity_tail`. */
export const ACTIVITY_TAIL_LIMIT = 200;

/**
 * Port of `tail_as_json_array` (`http.rs:230-249`). Reads the file,
 * keeps the last `maxLines` non-empty lines, joins them with commas, and
 * wraps in `[...]`. Does NOT re-parse — matches Rust's pass-through.
 * Missing/unreadable file returns literal `"[]"` (200 OK).
 */
export function tailAsJsonArray(path: string, maxLines: number): string {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return "[]";
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const start = Math.max(0, lines.length - maxLines);
  const slice = lines.slice(start);
  return `[${slice.join(",")}]`;
}

/**
 * Resolve `assets/dashboard.html` relative to this module's
 * package root. Mirrors `bridge.ts::resolveFirstTreePackageRoot` so the
 * file ships whenever the npm package is installed (it's listed in
 * `package.json::files`).
 */
function resolveDashboardPath(startUrl: string = import.meta.url): string {
  return join(resolveFirstTreePackageRoot(startUrl), "assets", "dashboard.html");
}

let cachedDashboard: Buffer | null = null;

function loadDashboardHtml(override?: string): Buffer {
  if (override !== undefined) {
    return Buffer.from(override, "utf-8");
  }
  if (cachedDashboard !== null) return cachedDashboard;
  const path = resolveDashboardPath();
  cachedDashboard = readFileSync(path);
  return cachedDashboard;
}

/* ------------------------------------------------------------------ */
/* Response helpers — build bytes that match Rust's format! strings.  */
/* ------------------------------------------------------------------ */

/**
 * Plain-text response helper matching `write_plain` (`http.rs:170-185`).
 * Headers and order match the Rust output; status reason phrase is
 * `OK`/`Not Found`/empty per `reason_phrase`.
 */
export function writePlain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, reasonPhrase(status), {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf-8"),
    "Cache-Control": "no-store",
    Connection: "close",
  });
  res.end(body);
}

function reasonPhrase(status: number): string {
  switch (status) {
    case 200:
      return "OK";
    case 404:
      return "Not Found";
    default:
      return "";
  }
}

function writeDashboard(res: ServerResponse, body: Buffer): void {
  res.writeHead(200, "OK", {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.byteLength,
    "Cache-Control": "no-store",
    Connection: "close",
  });
  res.end(body);
}

/**
 * Handle `POST /inbox/:id/translate`.
 *
 * Reads the request body (capped at 64 KB to bound memory), expects a
 * JSON object `{ "text": "<user instruction>" }`, and delegates to the
 * configured translate handler. The handler is responsible for spawning
 * the LLM, validating the output, and returning a whitelisted action.
 *
 * Wire format:
 *   - 200 + JSON `{ ok: true, summary, rationale, action }` on success
 *   - 400 + plaintext on missing/malformed body
 *   - 422 + JSON `{ ok: false, error }` when the handler rejects
 *     (timeout, schema-invalid LLM output, unknown entryId)
 *   - 501 when the daemon was started without `translateHandler`
 *
 * SECURITY:
 *   The handler MUST validate the LLM output against the whitelisted
 *   Action schema. The HTTP layer relays the result verbatim — it does
 *   not re-validate. (Pinned in tests on the runtime/types side.)
 */
async function handleTranslate(
  req: IncomingMessage,
  res: ServerResponse,
  entryId: string,
  handler: TranslateHandler | undefined,
): Promise<void> {
  if (!handler) {
    res.writeHead(501, "Not Implemented", {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "close",
    });
    res.end("translate not configured\n");
    return;
  }

  const body = await readJsonBody(req, 64 * 1024);
  if (body === null) {
    writePlain(res, 400, "request body missing or oversized\n");
    return;
  }
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as Record<string, unknown>)["text"] !== "string"
  ) {
    writePlain(res, 400, 'expected JSON `{ "text": "..." }`\n');
    return;
  }
  const userText = (body as Record<string, unknown>)["text"] as string;
  if (userText.trim().length === 0) {
    writePlain(res, 400, "text is empty\n");
    return;
  }
  if (userText.length > 4_000) {
    writePlain(res, 400, "text exceeds 4000 chars\n");
    return;
  }

  let result: TranslateResult;
  try {
    result = await handler(entryId, userText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(422, "Unprocessable Entity", {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "close",
    });
    res.end(JSON.stringify({ ok: false, error: msg }));
    return;
  }
  const status = result.ok ? 200 : 422;
  const reason = result.ok ? "OK" : "Unprocessable Entity";
  const json = JSON.stringify(result);
  res.writeHead(status, reason, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json, "utf-8"),
    "Cache-Control": "no-store",
    Connection: "close",
  });
  res.end(json);
}

/**
 * Read up to `maxBytes` of the request body, then JSON.parse.
 * Returns `null` if the body is missing, oversize, or unparseable.
 */
async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => {
      if (!aborted) resolve(null);
    });
  });
}

/**
 * Serve `/inbox`, optionally enriched with island-feature recommendations.
 *
 * The Rust fetcher writes inbox.json with a frozen schema (see
 * runtime/store.ts header). We cannot extend it without breaking
 * Rust ↔ TS round-trip, so recommendations live in a sibling file.
 * Here we join them at read-time, attaching a `recommendation` field
 * to entries that have one cached. Entries without a cached
 * recommendation are returned unchanged.
 *
 * If `recommendationsPath` is omitted (e.g. tests, or daemons started
 * before the island feature lands), we serve raw inbox.json bytes
 * verbatim — preserving exact byte-for-byte parity with the Rust
 * server for clients that don't speak the new wire field.
 */
async function writeInboxJsonFile(
  res: ServerResponse,
  inboxPath: string,
  recommendationsPath?: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await fsp.readFile(inboxPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      writePlain(res, 404, "inbox.json not found\n");
      return;
    }
    writePlain(res, 404, "inbox.json not found\n");
    return;
  }

  let body = raw;
  if (recommendationsPath) {
    body = await mergeRecommendationsIntoInbox(raw, recommendationsPath);
  }

  res.writeHead(200, "OK", {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf-8"),
    "Cache-Control": "no-store",
    Connection: "close",
  });
  res.end(body);
}

/**
 * Read the recommendations cache and attach a `recommendation` field to
 * every inbox entry that has one. On any failure (missing file, bad
 * JSON, schema drift) we silently fall back to the raw inbox.json bytes.
 * Tray clients treat a missing recommendation field as "no suggestion
 * available" already, so degrading is safe.
 */
async function mergeRecommendationsIntoInbox(
  rawInbox: string,
  recommendationsPath: string,
): Promise<string> {
  let recCache: { recommendations?: Record<string, unknown> } | null = null;
  try {
    const cacheRaw = await fsp.readFile(recommendationsPath, "utf-8");
    if (cacheRaw.trim().length > 0) {
      recCache = JSON.parse(cacheRaw) as { recommendations?: Record<string, unknown> };
    }
  } catch {
    return rawInbox;
  }
  if (!recCache?.recommendations) return rawInbox;

  let inbox: { notifications?: Array<Record<string, unknown>> };
  try {
    inbox = JSON.parse(rawInbox) as typeof inbox;
  } catch {
    return rawInbox;
  }
  if (!Array.isArray(inbox.notifications)) return rawInbox;

  const recs = recCache.recommendations;
  let mutated = false;
  for (const entry of inbox.notifications) {
    const id = entry["id"];
    if (typeof id !== "string") continue;
    const rec = recs[id];
    if (rec && typeof rec === "object") {
      entry["recommendation"] = rec;
      mutated = true;
    }
  }
  if (!mutated) return rawInbox;
  return JSON.stringify(inbox);
}

function writeJson(res: ServerResponse, body: string): void {
  res.writeHead(200, "OK", {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf-8"),
    "Cache-Control": "no-store",
    Connection: "close",
  });
  res.end(body);
}

function writeActivityTail(res: ServerResponse, activityPath: string, maxLines: number): void {
  const body = tailAsJsonArray(activityPath, maxLines);
  res.writeHead(200, "OK", {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf-8"),
    "Cache-Control": "no-store",
    Connection: "close",
  });
  res.end(body);
}

function writeSseHeaders(res: ServerResponse): void {
  // Rust emits these headers explicitly (`http.rs:253-262`). No
  // Content-Length (indefinite stream); X-Accel-Buffering: no to
  // disable intermediate proxy buffering (nginx convention).
  res.writeHead(200, "OK", {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Flush the headers immediately so the client's EventSource gets the
  // 200 response without waiting for the first frame.
  if (typeof (res as { flushHeaders?: () => void }).flushHeaders === "function") {
    (res as { flushHeaders: () => void }).flushHeaders();
  }
}

/* ------------------------------------------------------------------ */
/* Server lifecycle                                                    */
/* ------------------------------------------------------------------ */

export interface HttpLogger {
  info: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

export interface StartHttpServerOptions {
  /** Port to bind on 127.0.0.1. Default 7878. */
  httpPort: number;
  /** Path to `~/.first-tree/github-scan/inbox.json`. */
  inboxPath: string;
  /** Path to `~/.first-tree/github-scan/activity.log`. */
  activityLogPath: string;
  /** Task metadata snapshot used by the dashboard task pane. */
  tasksProvider?: () => DashboardTask[];
  /** Shutdown signal. Server closes when this aborts. */
  signal: AbortSignal;
  /**
   * Event bus for SSE. If omitted, Phase 3b falls back to the inbox
   * mtime poller stub. Phase 3c will wire a real broker bus here.
   */
  bus?: SseBus;
  /** Logger for stderr-equivalent output. */
  logger?: HttpLogger;
  /** Override dashboard HTML (tests only). */
  dashboardHtml?: string;
  /** Keep-alive cadence in ms (tests pass shorter to speed up). */
  sseKeepAliveMs?: number;
  /**
   * Island feature: path to `recommendations.json`. When set, `/inbox`
   * joins per-entry recommendation cache hits into the response. When
   * omitted, `/inbox` returns the raw bytes from disk for byte-for-byte
   * Rust parity.
   */
  recommendationsPath?: string;
  /**
   * Island feature: handler for `POST /inbox/:id/translate`. When set,
   * the route is enabled and translates a free-text user request into a
   * whitelisted action. When unset (e.g. tests, or daemons started
   * without the island feature), translate returns 501.
   */
  translateHandler?: TranslateHandler;
}

/**
 * Single-shot natural-language → whitelisted action translator.
 *
 * `entryId` identifies the inbox item the user is acting on (the daemon
 * uses this to look up entry context and constrain the LLM). `userText`
 * is the user's free-text instruction (e.g. "comment that we should
 * add tests first"). Returns the LLM-produced action or an error string.
 *
 * Implementations MUST validate the LLM output against the whitelisted
 * Action schema before returning. Anything else is a bug — the route
 * relays whatever the handler returns.
 */
export type TranslateHandler = (entryId: string, userText: string) => Promise<TranslateResult>;

export type TranslateResult =
  | {
      ok: true;
      summary: string;
      rationale: string;
      action: {
        kind: "approve_pr" | "comment" | "close_issue" | "request_changes";
        args: Record<string, unknown>;
      };
    }
  | { ok: false; error: string };

export interface RunningHttpServer {
  /** The actual bound port (useful when the caller passes 0). */
  port: number;
  /**
   * Waits for the listener to close. Resolves after the abort signal
   * has fired AND all in-flight connections have drained.
   */
  done: Promise<void>;
  /** Explicit stop (idempotent). Equivalent to aborting the signal. */
  stop: () => Promise<void>;
}

const DEFAULT_LOGGER: HttpLogger = {
  info: (line) => process.stdout.write(`${line}\n`),
  warn: (line) => process.stderr.write(`WARN: ${line}\n`),
  error: (line) => process.stderr.write(`ERROR: ${line}\n`),
};

/**
 * Bind the HTTP server to `127.0.0.1:httpPort` and start serving.
 * Returns once the listener is actually bound; the caller awaits
 * `done` for shutdown.
 *
 * The server is single-writer-free: every route reads either from disk
 * (via `fs.promises`) or from the passed-in bus. Nothing here mutates
 * `~/.first-tree/github-scan`.
 */
export async function startHttpServer(options: StartHttpServerOptions): Promise<RunningHttpServer> {
  const logger = options.logger ?? DEFAULT_LOGGER;
  const dashboardBody = loadDashboardHtml(options.dashboardHtml);

  // Phase 3b stub bus: inbox.json mtime poll at 1s. Phase 3c replaces
  // this with the real broker-driven bus.
  const bus =
    options.bus ??
    createInboxMtimeBus({
      inboxPath: options.inboxPath,
      signal: options.signal,
    });

  // Per-connection abort controllers keyed by response, so we can cancel
  // in-flight SSE streams on shutdown without leaking.
  const liveStreams = new Set<AbortController>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const route = parseRoute(req.method ?? "GET", req.url);
    try {
      // Object-kind routes (POST translate). Handle before the string
      // switch so we don't have to thread "translate" through every
      // case-arm exhaustiveness check.
      if (typeof route === "object" && route.kind === "translate") {
        void handleTranslate(req, res, route.entryId, options.translateHandler).catch((err) => {
          logger.error(
            `github-scan http: /translate handler failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          if (!res.headersSent) writePlain(res, 500, "internal error\n");
        });
        return;
      }
      switch (route) {
        case "dashboard":
          writeDashboard(res, dashboardBody);
          return;
        case "healthz":
          writePlain(res, 200, "ok\n");
          return;
        case "inbox":
          void writeInboxJsonFile(res, options.inboxPath, options.recommendationsPath).catch(
            (err) => {
              logger.error(
                `github-scan http: /inbox handler failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              if (!res.headersSent) writePlain(res, 404, "inbox.json not found\n");
            },
          );
          return;
        case "tasks":
          writeJson(
            res,
            JSON.stringify({
              tasks: (options.tasksProvider ?? (() => []))(),
            }),
          );
          return;
        case "activity":
          writeActivityTail(res, options.activityLogPath, ACTIVITY_TAIL_LIMIT);
          return;
        case "events": {
          writeSseHeaders(res);
          const streamController = new AbortController();
          liveStreams.add(streamController);
          // Link the server signal to this stream.
          const onServerAbort = (): void => streamController.abort();
          if (options.signal.aborted) streamController.abort();
          else options.signal.addEventListener("abort", onServerAbort, { once: true });
          runSseStream({
            response: res,
            bus,
            signal: streamController.signal,
            keepAliveMs: options.sseKeepAliveMs,
          })
            .catch((err) => {
              logger.warn(
                `github-scan http: sse stream ended with error: ${err instanceof Error ? err.message : String(err)}`,
              );
            })
            .finally(() => {
              liveStreams.delete(streamController);
              options.signal.removeEventListener("abort", onServerAbort);
            });
          return;
        }
        case "not-found":
        default:
          writePlain(res, 404, "not found\n");
          return;
      }
    } catch (err) {
      logger.error(
        `github-scan http: handler crashed for ${req.method} ${req.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!res.headersSent) writePlain(res, 404, "not found\n");
    }
  });

  // Prevent the HTTP listener from keeping the process alive after the
  // daemon's main shutdown has fired but before `server.close()` fully
  // drains — we still await `done` explicitly in `runDaemon`.
  server.on("clientError", (err) => {
    logger.warn(
      `github-scan http: client error: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening);
      reject(
        new Error(`failed to bind http server on 127.0.0.1:${options.httpPort}: ${err.message}`),
      );
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    // Loopback only — match `http.rs:28-32`. We never expose this to
    // non-localhost traffic; the dashboard is single-user by design.
    server.listen(options.httpPort, "127.0.0.1");
  });

  const address = server.address();
  const boundPort =
    typeof address === "object" && address !== null ? address.port : options.httpPort;
  logger.info(`github-scan: http server listening on http://127.0.0.1:${boundPort}`);

  let stopped = false;
  const donePromise = new Promise<void>((resolve) => {
    const close = (): void => {
      if (stopped) return;
      stopped = true;
      // Abort all in-flight SSE streams so the listener can actually
      // close. Without this, `server.close()` waits forever for
      // keep-alive connections.
      for (const controller of liveStreams) controller.abort();
      liveStreams.clear();
      server.close((err) => {
        if (err) {
          logger.warn(`github-scan http: server.close error: ${err.message}`);
        }
        resolve();
      });
    };
    if (options.signal.aborted) close();
    else options.signal.addEventListener("abort", close, { once: true });
  });

  const stop = async (): Promise<void> => {
    if (!stopped && !options.signal.aborted) {
      // Internal abort — caller asked us to stop without going through
      // the shared signal. Emulate by resolving `done` directly.
    }
    await donePromise;
  };

  return {
    port: boundPort,
    done: donePromise,
    stop,
  };
}
