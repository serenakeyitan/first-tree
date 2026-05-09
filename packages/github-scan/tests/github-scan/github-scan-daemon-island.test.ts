/**
 * Tests for the island-feature additions to the daemon HTTP server:
 *   - /inbox joins recommendations.json into per-entry recommendation field
 *   - POST /inbox/:id/translate translates natural language to action
 *   - SSE recommendation event encoding
 */
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseRoute,
  startHttpServer,
  type TranslateHandler,
} from "../../src/github-scan/engine/daemon/http.js";
import { encodeSseEvent } from "../../src/github-scan/engine/daemon/sse.js";

interface RawResponse {
  status: number;
  body: string;
  contentType: string;
}

function fetchRaw(
  port: number,
  path: string,
  options: { method?: string; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.body
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(options.body, "utf-8"),
            }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
            contentType: String(res.headers["content-type"] ?? ""),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const SAMPLE_INBOX = {
  last_poll: "2026-04-16T20:15:30Z",
  notifications: [
    {
      id: "h1",
      type: "PullRequest",
      reason: "review_requested",
      repo: "ex/repo",
      title: "feat: x",
      url: "https://api.github.com/repos/ex/repo/pulls/1",
      last_actor: "https://api.github.com/repos/ex/repo/issues/comments/1",
      updated_at: "2026-04-16T07:24:28Z",
      unread: true,
      priority: 5,
      number: 1,
      html_url: "https://github.com/ex/repo/pull/1",
      gh_state: "OPEN",
      labels: ["github-scan:human"],
      github_scan_status: "human",
    },
    {
      id: "n1",
      type: "PullRequest",
      reason: "author",
      repo: "ex/repo",
      title: "feat: y",
      url: "https://api.github.com/repos/ex/repo/pulls/2",
      last_actor: "https://api.github.com/repos/ex/repo/issues/comments/2",
      updated_at: "2026-04-16T07:24:29Z",
      unread: true,
      priority: 5,
      number: 2,
      html_url: "https://github.com/ex/repo/pull/2",
      gh_state: "OPEN",
      labels: [],
      github_scan_status: "new",
    },
  ],
};

const SAMPLE_RECOMMENDATIONS = {
  version: 1,
  recommendations: {
    h1: {
      id: "h1",
      summary: "Approve auto-rebase",
      rationale: "no conflicts, CI green",
      action: { kind: "approve_pr", args: { pr_number: 1, comment: "LGTM" } },
      generated_at: 1_700_000_000,
      model: "claude",
      input_hash: "abc",
    },
  },
};

function setupFiles() {
  const dir = mkdtempSync(join(tmpdir(), "island-http-"));
  const inboxPath = join(dir, "inbox.json");
  const activityPath = join(dir, "activity.log");
  const recPath = join(dir, "recommendations.json");
  writeFileSync(inboxPath, JSON.stringify(SAMPLE_INBOX), "utf-8");
  writeFileSync(activityPath, "", "utf-8");
  writeFileSync(recPath, JSON.stringify(SAMPLE_RECOMMENDATIONS), "utf-8");
  return { dir, inboxPath, activityPath, recPath };
}

describe("parseRoute (island routes)", () => {
  it("matches POST /inbox/:id/translate", () => {
    const r = parseRoute("POST", "/inbox/h1/translate");
    expect(typeof r === "object" && r.kind === "translate" && r.entryId).toBe("h1");
  });

  it("decodes percent-encoded ids", () => {
    const r = parseRoute("POST", "/inbox/abc%2Fdef/translate");
    expect(typeof r === "object" && r.kind === "translate" && r.entryId).toBe("abc/def");
  });

  it("rejects GET on translate path", () => {
    expect(parseRoute("GET", "/inbox/h1/translate")).toBe("not-found");
  });

  it("rejects POST on non-translate paths", () => {
    expect(parseRoute("POST", "/inbox")).toBe("not-found");
    expect(parseRoute("POST", "/inbox/h1")).toBe("not-found");
  });
});

describe("/inbox merges recommendations", () => {
  let setup: ReturnType<typeof setupFiles>;
  let port = 0;
  let abort: AbortController;
  let done: Promise<void>;

  beforeEach(async () => {
    setup = setupFiles();
    abort = new AbortController();
    const server = await startHttpServer({
      httpPort: 0,
      inboxPath: setup.inboxPath,
      activityLogPath: setup.activityPath,
      recommendationsPath: setup.recPath,
      signal: abort.signal,
      sseKeepAliveMs: 5000,
    });
    port = server.port;
    done = server.done;
  });
  afterEach(async () => {
    abort.abort();
    await done.catch(() => {});
    rmSync(setup.dir, { recursive: true, force: true });
  });

  it("attaches recommendation field to matching human entries", async () => {
    const res = await fetchRaw(port, "/inbox");
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    const h1 = json.notifications.find((n: { id: string }) => n.id === "h1");
    const n1 = json.notifications.find((n: { id: string }) => n.id === "n1");
    expect(h1.recommendation).toBeDefined();
    expect(h1.recommendation.summary).toBe("Approve auto-rebase");
    expect(h1.recommendation.action.kind).toBe("approve_pr");
    // n1 has no recommendation cached, so the field is absent.
    expect(n1.recommendation).toBeUndefined();
  });

  it("falls back to raw inbox when recommendations are missing", async () => {
    abort.abort();
    await done.catch(() => {});
    rmSync(setup.recPath);
    const a2 = new AbortController();
    const server2 = await startHttpServer({
      httpPort: 0,
      inboxPath: setup.inboxPath,
      activityLogPath: setup.activityPath,
      recommendationsPath: setup.recPath,
      signal: a2.signal,
      sseKeepAliveMs: 5000,
    });
    try {
      const res = await fetchRaw(server2.port, "/inbox");
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      // No file → no recommendations attached.
      for (const n of json.notifications) {
        expect(n.recommendation).toBeUndefined();
      }
    } finally {
      a2.abort();
      await server2.done.catch(() => {});
    }
  });
});

describe("POST /inbox/:id/translate", () => {
  let setup: ReturnType<typeof setupFiles>;
  let port = 0;
  let abort: AbortController;
  let done: Promise<void>;
  let lastCall: { entryId: string; userText: string } | null = null;

  beforeEach(async () => {
    setup = setupFiles();
    abort = new AbortController();
    lastCall = null;
    const handler: TranslateHandler = async (entryId, userText) => {
      lastCall = { entryId, userText };
      if (entryId === "fail") {
        return { ok: false, error: "synthetic failure" };
      }
      return {
        ok: true,
        summary: "Comment with user text",
        rationale: "user requested",
        action: {
          kind: "comment",
          args: { number: 1, target: "pr", body: userText },
        },
      };
    };
    const server = await startHttpServer({
      httpPort: 0,
      inboxPath: setup.inboxPath,
      activityLogPath: setup.activityPath,
      recommendationsPath: setup.recPath,
      translateHandler: handler,
      signal: abort.signal,
      sseKeepAliveMs: 5000,
    });
    port = server.port;
    done = server.done;
  });
  afterEach(async () => {
    abort.abort();
    await done.catch(() => {});
    rmSync(setup.dir, { recursive: true, force: true });
  });

  it("returns 200 with the structured action on success", async () => {
    const res = await fetchRaw(port, "/inbox/h1/translate", {
      method: "POST",
      body: JSON.stringify({ text: "tests required" }),
    });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/json");
    const json = JSON.parse(res.body);
    expect(json.ok).toBe(true);
    expect(json.action.kind).toBe("comment");
    expect(json.action.args.body).toBe("tests required");
    expect(lastCall?.entryId).toBe("h1");
    expect(lastCall?.userText).toBe("tests required");
  });

  it("returns 422 on handler-level failure", async () => {
    const res = await fetchRaw(port, "/inbox/fail/translate", {
      method: "POST",
      body: JSON.stringify({ text: "x" }),
    });
    expect(res.status).toBe(422);
    const json = JSON.parse(res.body);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("synthetic failure");
  });

  it("returns 400 for missing body", async () => {
    const res = await fetchRaw(port, "/inbox/h1/translate", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty text", async () => {
    const res = await fetchRaw(port, "/inbox/h1/translate", {
      method: "POST",
      body: JSON.stringify({ text: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing text field", async () => {
    const res = await fetchRaw(port, "/inbox/h1/translate", {
      method: "POST",
      body: JSON.stringify({ wrong: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects oversized text", async () => {
    const res = await fetchRaw(port, "/inbox/h1/translate", {
      method: "POST",
      body: JSON.stringify({ text: "a".repeat(5_000) }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON body", async () => {
    const res = await fetchRaw(port, "/inbox/h1/translate", {
      method: "POST",
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("/translate returns 501 when handler not configured", () => {
  let setup: ReturnType<typeof setupFiles>;
  let port = 0;
  let abort: AbortController;
  let done: Promise<void>;

  beforeEach(async () => {
    setup = setupFiles();
    abort = new AbortController();
    const server = await startHttpServer({
      httpPort: 0,
      inboxPath: setup.inboxPath,
      activityLogPath: setup.activityPath,
      signal: abort.signal,
      sseKeepAliveMs: 5000,
    });
    port = server.port;
    done = server.done;
  });
  afterEach(async () => {
    abort.abort();
    await done.catch(() => {});
    rmSync(setup.dir, { recursive: true, force: true });
  });

  it("returns 501 when daemon was started without translateHandler", async () => {
    const res = await fetchRaw(port, "/inbox/h1/translate", {
      method: "POST",
      body: JSON.stringify({ text: "x" }),
    });
    expect(res.status).toBe(501);
  });
});

describe("encodeSseEvent (recommendation kind)", () => {
  it("encodes recommendation events with the expected wire format", () => {
    const frame = encodeSseEvent({
      kind: "recommendation",
      id: "h1",
      summary: "Approve",
      action_kind: "approve_pr",
    });
    expect(frame).toContain("event: recommendation\n");
    expect(frame).toContain('"id":"h1"');
    expect(frame).toContain('"summary":"Approve"');
    expect(frame).toContain('"action_kind":"approve_pr"');
    expect(frame.endsWith("\n\n")).toBe(true);
  });

  it("escapes embedded quotes in summary", () => {
    const frame = encodeSseEvent({
      kind: "recommendation",
      id: "x",
      summary: 'has "quotes"',
      action_kind: "comment",
    });
    expect(frame).toContain('"summary":"has \\"quotes\\""');
  });
});
