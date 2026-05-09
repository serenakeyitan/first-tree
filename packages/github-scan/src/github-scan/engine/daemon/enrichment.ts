/**
 * Island feature: LLM enrichment worker.
 *
 * For every inbox entry whose `github_scan_status === "human"`, spawn the
 * local `claude` CLI to produce a structured action recommendation, and
 * cache it to `recommendations.json`. The `/inbox` HTTP route joins the
 * cache when serving entries to clients.
 *
 * Why local `claude` CLI:
 *   - Uses the user's existing Claude subscription. No daemon-side API key.
 *   - --bare skips hooks/CLAUDE.md/memory: we want a clean inference call.
 *   - --no-session-persistence keeps `~/.claude/projects` clean.
 *   - --json-schema gives us schema-validated JSON output, eliminating the
 *     need to parse free-form text or fence ```json blocks.
 *
 * Concurrency:
 *   - Worker processes one entry at a time. Cold start of `claude` is
 *     typically ~3-8s; processing more in parallel does not pay off and
 *     would race on the recommendations.json lock.
 *   - The worker is restartable: if interrupted mid-call, the missing
 *     recommendation is regenerated on next poll.
 *
 * Failure policy:
 *   - If `claude` exits non-zero or the JSON does not validate, log a
 *     warning and skip. The entry surfaces in /inbox without a
 *     recommendation field; the tray still shows it (Execute falls back
 *     to "Open in browser" client-side).
 *
 * Cache key:
 *   - sha256(`${id}:${updated_at}`). When `updated_at` changes (new
 *     comment, label, etc.), the cache entry is treated as stale and
 *     re-generated on the next pass.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import {
  ActionSchema,
  type Action,
  type InboxEntry,
  type Recommendation,
} from "../runtime/types.js";

import { putRecommendation, readRecommendations } from "../runtime/recommendations-store.js";

/** JSON schema enforced by `claude --json-schema`. Must match `RecommendationLLMOutputSchema`. */
const LLM_OUTPUT_JSON_SCHEMA = {
  type: "object",
  required: ["summary", "rationale", "action"],
  properties: {
    summary: { type: "string", maxLength: 200 },
    rationale: { type: "string", maxLength: 2000 },
    action: {
      type: "object",
      required: ["kind", "args"],
      properties: {
        kind: {
          type: "string",
          enum: ["approve_pr", "comment", "close_issue", "request_changes"],
        },
        args: { type: "object" },
      },
    },
  },
} as const;

export interface EnrichmentLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const NULL_LOGGER: EnrichmentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface EnrichmentDeps {
  /**
   * Path to `recommendations.json`. Pass through from
   * `resolveGitHubScanPaths`.
   */
  recommendationsPath: string;
  /**
   * Override the executable used to call Claude. Defaults to "claude" on PATH.
   * Tests pass a stub script.
   */
  claudeBinary?: string;
  /** Override the model. Defaults to Claude's --bare default. */
  model?: string;
  /** PATH to expose to the spawned `claude` process. */
  pathEnv?: string;
  /** Per-call timeout in ms. Default 60s — `claude` cold start can be ~10s. */
  timeoutMs?: number;
  logger?: EnrichmentLogger;
}

/**
 * Hash the inputs the LLM is asked to reason about. Recommendations whose
 * stored hash matches the entry's current hash are reused as-is.
 */
export function entryInputHash(entry: InboxEntry): string {
  return createHash("sha256").update(`${entry.id}:${entry.updated_at}`).digest("hex");
}

/**
 * Build the LLM prompt for one entry. Kept short — the schema does the
 * heavy lifting, we just need to brief the model on the context.
 */
export function buildPrompt(entry: InboxEntry): string {
  const number = entry.number ?? 0;
  const target = entry.type === "PullRequest" ? "PR" : "issue";
  return [
    `You are an assistant helping a developer triage GitHub notifications.`,
    `One of their repositories has flagged this notification as needing human attention.`,
    ``,
    `Repository: ${entry.repo}`,
    `Type: ${entry.type}`,
    `Title: ${entry.title}`,
    `${target} number: ${number}`,
    `Last actor: ${entry.last_actor}`,
    `Reason it surfaced: ${entry.reason}`,
    `URL: ${entry.html_url}`,
    `State: ${entry.gh_state ?? "unknown"}`,
    `Labels: ${entry.labels.join(", ") || "(none)"}`,
    ``,
    `Suggest ONE action the developer should take. Choose one of these action kinds:`,
    `  - approve_pr        approve a PR (only when there's clear evidence it's ready)`,
    `  - comment           leave a comment requesting more info or giving feedback`,
    `  - close_issue       close an issue (resolved, duplicate, or out-of-scope)`,
    `  - request_changes   request changes on a PR (problems found)`,
    ``,
    `Return ONLY a JSON object matching the provided schema. Do not include any prose.`,
    ``,
    `Conservative defaults: when in doubt, recommend "comment" with a question`,
    `rather than a destructive or approval action. Never recommend approving a PR`,
    `you do not have evidence is correct. Never recommend closing an issue without`,
    `acknowledging the reporter's input.`,
  ].join("\n");
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Spawn the claude CLI with the given prompt and wait for completion.
 * Returns stdout/stderr/exit code rather than throwing — caller decides
 * how to handle non-zero exits.
 *
 * Auth model: we deliberately do NOT pass `--bare`. `--bare` disables
 * OAuth lookup entirely (claude --help: "OAuth and keychain are never
 * read"), forcing ANTHROPIC_API_KEY usage. The island design uses the
 * user's own Claude subscription, so OAuth must work. We instead pass
 * `--setting-sources ""` and `--no-session-persistence` to keep the
 * spawn clean (no user CLAUDE.md / hooks / project memory loaded into
 * the prompt) without breaking auth.
 *
 * One quirk: when run as a child of Claude Desktop / Claude Code itself,
 * the parent injects an empty `ANTHROPIC_API_KEY=""`. The CLI treats
 * that as "API key configured" and skips OAuth, then 401s. We strip it
 * out of the spawn env (only when blank) so OAuth fallback works.
 */
export async function spawnClaude(prompt: string, deps: EnrichmentDeps): Promise<SpawnResult> {
  const exe = deps.claudeBinary ?? "claude";
  const args = [
    "-p",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(LLM_OUTPUT_JSON_SCHEMA),
  ];
  if (deps.model) args.push("--model", deps.model);

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (deps.pathEnv) env.PATH = deps.pathEnv;
  // Don't let an empty ANTHROPIC_API_KEY (injected by Claude Desktop into
  // child envs) suppress OAuth fallback. Only delete when blank — a real
  // key should still take precedence.
  if (env.ANTHROPIC_API_KEY === "") delete env.ANTHROPIC_API_KEY;

  return new Promise<SpawnResult>((resolve) => {
    const child = spawn(exe, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, deps.timeoutMs ?? 60_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + (stderr ? "\n" : "") + (err.message ?? String(err)),
        code: null,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * `claude --output-format json` wraps the model output in an envelope:
 *   { type: "result", subtype: "success", result: "<json string>", ... }
 * Or:
 *   { type: "result", subtype: "error", error: "..." }
 *
 * We only need the inner `result` string; everything else is wrapper.
 * If the wrapper isn't recognized, fall back to treating stdout as the
 * raw result (some `claude` versions have varied this surface).
 */
export function extractResultPayload(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).result === "string"
    ) {
      return ((parsed as Record<string, unknown>).result as string).trim();
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).type === "result"
    ) {
      // Wrapper present but no string `result` — likely an error envelope.
      return "";
    }
    // The output itself was already the model's JSON.
    return trimmed;
  } catch {
    return trimmed;
  }
}

export interface EnrichOneResult {
  /** True if a fresh recommendation was written. */
  wrote: boolean;
  /** True if the cache already had a fresh recommendation for this entry. */
  cacheHit: boolean;
  /** Set on failure paths. */
  error?: string;
  /** Set when `wrote` is true. */
  recommendation?: Recommendation;
}

/**
 * Enrich one entry: cache check → spawn claude → parse → write.
 *
 * Returns a structured result so the caller can publish events for fresh
 * writes without having to inspect the cache twice.
 */
export async function enrichOne(entry: InboxEntry, deps: EnrichmentDeps): Promise<EnrichOneResult> {
  const logger = deps.logger ?? NULL_LOGGER;
  const inputHash = entryInputHash(entry);

  // Cache check: existing rec with the same input_hash is considered fresh.
  try {
    const cache = readRecommendations(deps.recommendationsPath);
    const existing = cache.recommendations[entry.id];
    if (existing && existing.input_hash === inputHash) {
      return { wrote: false, cacheHit: true };
    }
  } catch (err) {
    logger.warn(
      `enrichment: ignoring corrupted recommendations cache: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const prompt = buildPrompt(entry);
  const spawnResult = await spawnClaude(prompt, deps);
  if (spawnResult.timedOut) {
    return { wrote: false, cacheHit: false, error: "claude CLI timed out" };
  }
  if (spawnResult.code !== 0) {
    return {
      wrote: false,
      cacheHit: false,
      error: `claude CLI exited ${spawnResult.code ?? "null"}: ${spawnResult.stderr.slice(0, 500)}`,
    };
  }

  const payload = extractResultPayload(spawnResult.stdout);
  if (payload.length === 0) {
    return { wrote: false, cacheHit: false, error: "claude CLI produced empty output" };
  }

  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch (err) {
    return {
      wrote: false,
      cacheHit: false,
      error: `claude CLI output was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // The schema validation here is the load-bearing safety check: anything
  // outside our whitelisted action shapes is rejected before it can reach
  // the dispatcher. This is the single source of truth for "what actions
  // can the LLM ask the tray to take".
  const inner = json as { summary?: unknown; rationale?: unknown; action?: unknown };
  const action: Action | null = (() => {
    const parsed = ActionSchema.safeParse(inner.action);
    return parsed.success ? parsed.data : null;
  })();

  if (action === null || typeof inner.summary !== "string" || typeof inner.rationale !== "string") {
    return {
      wrote: false,
      cacheHit: false,
      error: "claude CLI output failed schema validation",
    };
  }

  const rec: Recommendation = {
    id: entry.id,
    summary: inner.summary.slice(0, 200),
    rationale: inner.rationale.slice(0, 2000),
    action,
    generated_at: Math.floor(Date.now() / 1000),
    model: deps.model ?? "claude",
    input_hash: inputHash,
  };

  await putRecommendation(rec, { recommendationsPath: deps.recommendationsPath });
  return { wrote: true, cacheHit: false, recommendation: rec };
}

/**
 * Process every `human` entry in `entries`. Sequentially — see header
 * comment on concurrency.
 */
export async function enrichBatch(
  entries: ReadonlyArray<InboxEntry>,
  deps: EnrichmentDeps,
  onWrote?: (rec: Recommendation) => void,
): Promise<{ wrote: number; cacheHits: number; errors: number }> {
  const logger = deps.logger ?? NULL_LOGGER;
  let wrote = 0;
  let cacheHits = 0;
  let errors = 0;
  for (const entry of entries) {
    if (entry.github_scan_status !== "human") continue;
    const result = await enrichOne(entry, deps);
    if (result.wrote) {
      wrote += 1;
      if (result.recommendation && onWrote) onWrote(result.recommendation);
    } else if (result.cacheHit) {
      cacheHits += 1;
    } else if (result.error) {
      errors += 1;
      logger.warn(`enrichment: ${entry.id}: ${result.error}`);
    }
  }
  return { wrote, cacheHits, errors };
}

/**
 * Build the LLM prompt for the single-shot natural-language → action
 * translation used by the island's "Do other..." path. The LLM sees:
 *   - the inbox entry context (so it knows what's being acted on)
 *   - the user's free-text instruction
 *   - the same whitelist + JSON-schema constraint as `buildPrompt`
 *
 * Conservatism is reduced here vs the auto-suggestion prompt: the user
 * has explicitly asked for an action, so we should follow their lead
 * (subject to whitelist).
 */
export function buildTranslatePrompt(entry: InboxEntry, userText: string): string {
  const number = entry.number ?? 0;
  const target = entry.type === "PullRequest" ? "PR" : "issue";
  return [
    `You are translating a developer's natural-language instruction into a`,
    `structured GitHub action.`,
    ``,
    `Context — the notification they're acting on:`,
    `  Repository: ${entry.repo}`,
    `  Type: ${entry.type}`,
    `  Title: ${entry.title}`,
    `  ${target} number: ${number}`,
    `  URL: ${entry.html_url}`,
    `  State: ${entry.gh_state ?? "unknown"}`,
    ``,
    `The developer says:`,
    `  ${userText.replace(/\n/g, "\n  ")}`,
    ``,
    `Translate that into ONE of the four whitelisted actions:`,
    `  - approve_pr        approve a PR`,
    `  - comment           leave a comment with the body the user implied`,
    `  - close_issue       close an issue (with an explanatory comment)`,
    `  - request_changes   request changes on a PR (with the user's body)`,
    ``,
    `Return ONLY a JSON object matching the provided schema. Do not include any prose.`,
    ``,
    `Use the user's words for any body/comment field — do not paraphrase or`,
    `soften unless they ask. If the user's instruction does not fit any`,
    `whitelisted action, default to "comment" with the user's text as the body.`,
  ].join("\n");
}

export interface TranslateResult {
  ok: true;
  summary: string;
  rationale: string;
  action: Action;
}
export interface TranslateError {
  ok: false;
  error: string;
}

/**
 * Single-shot translate. Spawns claude with the same JSON-schema
 * constraint as `enrichOne` but with the translate prompt. Used by the
 * `POST /inbox/:id/translate` route.
 *
 * Does NOT touch the recommendations cache — the result goes straight
 * back to the caller, who decides whether to execute.
 */
export async function translate(
  entry: InboxEntry,
  userText: string,
  deps: Omit<EnrichmentDeps, "recommendationsPath"> & { recommendationsPath?: string },
): Promise<TranslateResult | TranslateError> {
  const prompt = buildTranslatePrompt(entry, userText);
  const spawnResult = await spawnClaude(prompt, {
    ...deps,
    recommendationsPath: deps.recommendationsPath ?? "/dev/null",
  });
  if (spawnResult.timedOut) {
    return { ok: false, error: "claude CLI timed out" };
  }
  if (spawnResult.code !== 0) {
    return {
      ok: false,
      error: `claude CLI exited ${spawnResult.code ?? "null"}: ${spawnResult.stderr.slice(0, 500)}`,
    };
  }
  const payload = extractResultPayload(spawnResult.stdout);
  if (payload.length === 0) {
    return { ok: false, error: "claude CLI produced empty output" };
  }
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch (err) {
    return {
      ok: false,
      error: `claude CLI output was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const inner = json as { summary?: unknown; rationale?: unknown; action?: unknown };
  const parsed = ActionSchema.safeParse(inner.action);
  if (!parsed.success || typeof inner.summary !== "string" || typeof inner.rationale !== "string") {
    return { ok: false, error: "claude CLI output failed schema validation" };
  }
  return {
    ok: true,
    summary: inner.summary.slice(0, 200),
    rationale: inner.rationale.slice(0, 2000),
    action: parsed.data,
  };
}
