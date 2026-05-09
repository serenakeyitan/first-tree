/**
 * Real-claude smoke test for the island enrichment worker.
 *
 * NOT run by default — gated on `RUN_REAL_CLAUDE_SMOKE=1`. The point is to
 * verify the prompt + JSON schema + extraction path end-to-end against a
 * live LLM, since the regular tests use a mocked shell script.
 *
 * Usage:
 *   RUN_REAL_CLAUDE_SMOKE=1 pnpm vitest run github-scan-enrichment-real
 *
 * Costs a real `claude -p` invocation (~5-15s, charges to user's plan).
 *
 * KNOWN ENVIRONMENT QUIRK: when this test is launched by Claude Code (or
 * Claude Desktop) the parent injects `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`
 * and an empty `ANTHROPIC_API_KEY`. The CLI then refuses to read the user's
 * OAuth keychain entry, so the spawn 401s. The enrichment code unsets a
 * blank `ANTHROPIC_API_KEY` to give OAuth a chance, but the host-managed
 * flag still blocks keychain reads. To verify on a developer machine,
 * launch a regular terminal (NOT inside Claude Code) and run this test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { enrichOne } from "../../src/github-scan/engine/daemon/enrichment.js";
import type { InboxEntry } from "../../src/github-scan/engine/runtime/types.js";

const RUN = process.env.RUN_REAL_CLAUDE_SMOKE === "1";

const FAKE_ENTRY: InboxEntry = {
  id: "smoke-test-1",
  type: "PullRequest",
  reason: "review_requested",
  repo: "agent-team-foundation/first-tree",
  title: "feat(github-scan): add daemon SSE channel for recommendations",
  url: "https://api.github.com/repos/agent-team-foundation/first-tree/pulls/4",
  last_actor: "https://api.github.com/repos/agent-team-foundation/first-tree/issues/comments/1",
  updated_at: "2026-05-09T18:30:00Z",
  unread: true,
  priority: 5,
  number: 4,
  html_url: "https://github.com/agent-team-foundation/first-tree/pull/4",
  gh_state: "OPEN",
  labels: ["github-scan:human"],
  github_scan_status: "human",
};

describe.skipIf(!RUN)("enrichment against real claude CLI", () => {
  it("produces a whitelisted recommendation for a realistic PR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "island-smoke-"));
    try {
      const recPath = join(dir, "recommendations.json");
      const start = Date.now();
      const result = await enrichOne(FAKE_ENTRY, {
        recommendationsPath: recPath,
        timeoutMs: 90_000,
        logger: {
          info: (m) => console.log("[info]", m),
          warn: (m) => console.warn("[warn]", m),
          error: (m) => console.error("[err]", m),
        },
      });
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`\n--- claude returned in ${elapsed}s ---\n${JSON.stringify(result, null, 2)}\n`);
      expect(result.error).toBeUndefined();
      expect(result.wrote).toBe(true);
      expect(result.recommendation).toBeDefined();
      expect(["approve_pr", "comment", "close_issue", "request_changes"]).toContain(
        result.recommendation?.action.kind,
      );
      expect(result.recommendation?.summary.length).toBeGreaterThan(0);
      expect(result.recommendation?.summary.length).toBeLessThanOrEqual(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
