/**
 * End-to-end test for the island daemon HTTP additions.
 *
 * Spins up the real `startHttpServer` against fixture inbox.json and
 * recommendations.json, then makes real loopback HTTP requests to
 * /inbox, POST /inbox/:id/translate, and verifies the wire shape is
 * what the tray will see in production.
 */
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startHttpServer,
  type RunningHttpServer,
} from "../../src/github-scan/engine/daemon/http.js";

interface RawResponse {
  status: number;
  body: string;
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
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const FIXTURE_INBOX = {
  last_poll: "2026-05-09T01:00:00Z",
  notifications: [
    {
      id: "e2e-1",
      type: "PullRequest",
      reason: "review_requested",
      repo: "ex/repo",
      title: "feat: e2e test PR",
      url: "https://api.github.com/repos/ex/repo/pulls/1",
      last_actor: "https://api.github.com/repos/ex/repo/issues/comments/1",
      updated_at: "2026-05-09T00:00:00Z",
      unread: true,
      priority: 5,
      number: 1,
      html_url: "https://github.com/ex/repo/pull/1",
      gh_state: "OPEN",
      labels: ["github-scan:human"],
      github_scan_status: "human",
    },
    {
      id: "e2e-2",
      type: "Issue",
      reason: "mention",
      repo: "ex/repo",
      title: "bug: something",
      url: "https://api.github.com/repos/ex/repo/issues/2",
      last_actor: "https://api.github.com/repos/ex/repo/issues/comments/2",
      updated_at: "2026-05-09T00:01:00Z",
      unread: true,
      priority: 4,
      number: 2,
      html_url: "https://github.com/ex/repo/issues/2",
      gh_state: "OPEN",
      labels: [],
      github_scan_status: "new",
    },
  ],
};

const FIXTURE_RECS = {
  version: 1,
  recommendations: {
    "e2e-1": {
      id: "e2e-1",
      summary: "Approve PR (E2E test)",
      rationale: "synthetic recommendation for E2E",
      action: {
        kind: "approve_pr",
        args: { pr_number: 1, comment: "LGTM (E2E)" },
      },
      generated_at: 1715212800,
      model: "e2e-mock",
      input_hash: "e2e-hash",
    },
  },
};

describe("island daemon E2E", () => {
  let dir: string;
  let abort: AbortController;
  let server: RunningHttpServer;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "island-e2e-"));
    writeFileSync(join(dir, "inbox.json"), JSON.stringify(FIXTURE_INBOX), "utf-8");
    writeFileSync(join(dir, "recommendations.json"), JSON.stringify(FIXTURE_RECS), "utf-8");
    writeFileSync(join(dir, "activity.log"), "", "utf-8");
    abort = new AbortController();
    server = await startHttpServer({
      httpPort: 0,
      inboxPath: join(dir, "inbox.json"),
      activityLogPath: join(dir, "activity.log"),
      recommendationsPath: join(dir, "recommendations.json"),
      translateHandler: async (entryId, userText) => ({
        ok: true,
        summary: `Comment with: ${userText.slice(0, 40)}`,
        rationale: "stub translate handler",
        action: {
          kind: "comment",
          args: { number: 1, target: "pr", body: userText },
        },
      }),
      signal: abort.signal,
      sseKeepAliveMs: 5000,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
  });

  afterAll(async () => {
    abort.abort();
    await server.done.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("E2E: GET /inbox returns the merged shape the tray will consume", async () => {
    const res = await fetchRaw(server.port, "/inbox");
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);

    // Top-level shape unchanged from Rust contract.
    expect(json.last_poll).toBe(FIXTURE_INBOX.last_poll);
    expect(Array.isArray(json.notifications)).toBe(true);
    expect(json.notifications).toHaveLength(2);

    // Human entry has a joined recommendation.
    const human = json.notifications.find((n: { id: string }) => n.id === "e2e-1");
    expect(human).toBeDefined();
    expect(human.github_scan_status).toBe("human");
    expect(human.recommendation).toBeDefined();
    expect(human.recommendation.summary).toBe("Approve PR (E2E test)");
    expect(human.recommendation.action.kind).toBe("approve_pr");
    expect(human.recommendation.action.args.pr_number).toBe(1);
    expect(human.recommendation.action.args.comment).toBe("LGTM (E2E)");

    // New entry has no recommendation cached, so the field is absent
    // (NOT null — the tray's optional decoder treats absent vs null
    // the same, but absence is what we emit when the cache misses).
    const newEntry = json.notifications.find((n: { id: string }) => n.id === "e2e-2");
    expect(newEntry).toBeDefined();
    expect(newEntry.recommendation).toBeUndefined();
  });

  it("E2E: POST /inbox/:id/translate returns a whitelisted action", async () => {
    const res = await fetchRaw(server.port, "/inbox/e2e-1/translate", {
      method: "POST",
      body: JSON.stringify({ text: "tests required please" }),
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.ok).toBe(true);
    expect(json.action.kind).toBe("comment");
    expect(json.action.args.body).toBe("tests required please");
    // Summary echoes user text — verifies handler received userText, not
    // some stale value from a previous request.
    expect(json.summary).toContain("tests required please");
  });

  it("E2E: GET /healthz still works", async () => {
    const res = await fetchRaw(server.port, "/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok\n");
  });
});
