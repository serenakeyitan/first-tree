/**
 * Tests for the island feature's enrichment worker:
 * `src/github-scan/engine/daemon/enrichment.ts`.
 *
 * The worker is exercised against a mocked `claude` binary — a small
 * shell script we write to a temp dir and pass in via `claudeBinary`.
 * That keeps these tests hermetic (no real LLM calls) while still
 * verifying the spawn / stdin / json-extraction path end-to-end.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPrompt,
  enrichBatch,
  enrichOne,
  entryInputHash,
} from "../../src/github-scan/engine/daemon/enrichment.js";
import { readRecommendations } from "../../src/github-scan/engine/runtime/recommendations-store.js";
import type { InboxEntry } from "../../src/github-scan/engine/runtime/types.js";

function makeEntry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: "entry-1",
    type: "PullRequest",
    reason: "review_requested",
    repo: "example-org/repo",
    title: "feat: add foo",
    url: "https://api.github.com/repos/example-org/repo/pulls/42",
    last_actor: "https://api.github.com/repos/example-org/repo/issues/comments/1",
    updated_at: "2026-04-16T07:24:28Z",
    unread: true,
    priority: 5,
    number: 42,
    html_url: "https://github.com/example-org/repo/pull/42",
    gh_state: "OPEN",
    labels: ["github-scan:human"],
    github_scan_status: "human",
    ...overrides,
  };
}

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "enrich-"));
}

/**
 * Write a mocked `claude` shell script that emits the given stdout (no
 * stdin reading), with an optional non-zero exit code.
 *
 * The real `claude --output-format json` wraps the model's response in
 * an envelope `{type, subtype, result}`. Tests can opt into emitting
 * either the envelope or a bare object; `enrichment.extractResultPayload`
 * handles both.
 */
function writeMockClaude(
  dir: string,
  options: {
    stdout: string;
    exitCode?: number;
    stderr?: string;
    sleepSec?: number;
  },
): string {
  const path = join(dir, "claude");
  const lines = ["#!/bin/sh"];
  if (options.sleepSec && options.sleepSec > 0) {
    lines.push(`sleep ${options.sleepSec}`);
  }
  if (options.stderr) {
    // Single-quote-escape: replace ' with '\''
    const escaped = options.stderr.replace(/'/g, "'\\''");
    lines.push(`printf '%s' '${escaped}' 1>&2`);
  }
  // Read and discard stdin so the producer's `child.stdin.end()` never blocks.
  lines.push("cat >/dev/null");
  // Use printf to avoid echo's newline differences across shells.
  const escaped = options.stdout.replace(/'/g, "'\\''");
  lines.push(`printf '%s' '${escaped}'`);
  lines.push(`exit ${options.exitCode ?? 0}`);
  writeFileSync(path, lines.join("\n"));
  chmodSync(path, 0o755);
  return path;
}

const VALID_INNER_JSON = JSON.stringify({
  summary: "Approve auto-rebase",
  rationale: "Branch is 2 commits behind main, no conflicts, CI green",
  action: {
    kind: "approve_pr",
    args: { pr_number: 42, comment: "LGTM" },
  },
});

const VALID_ENVELOPE = JSON.stringify({
  type: "result",
  subtype: "success",
  result: VALID_INNER_JSON,
});

describe("buildPrompt", () => {
  it("includes the title and repo", () => {
    const prompt = buildPrompt(makeEntry());
    expect(prompt).toContain("example-org/repo");
    expect(prompt).toContain("feat: add foo");
  });

  it("brief the model on the four allowed action kinds", () => {
    const prompt = buildPrompt(makeEntry());
    for (const kind of ["approve_pr", "comment", "close_issue", "request_changes"]) {
      expect(prompt).toContain(kind);
    }
  });
});

describe("entryInputHash", () => {
  it("changes when updated_at changes", () => {
    const a = entryInputHash(makeEntry({ updated_at: "2026-04-16T07:24:28Z" }));
    const b = entryInputHash(makeEntry({ updated_at: "2026-04-16T07:24:29Z" }));
    expect(a).not.toBe(b);
  });

  it("is stable for the same input", () => {
    const a = entryInputHash(makeEntry());
    const b = entryInputHash(makeEntry());
    expect(a).toBe(b);
  });
});

describe("enrichOne", () => {
  let dir: string;
  let recPath: string;
  beforeEach(() => {
    dir = mkTmp();
    recPath = join(dir, "recommendations.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces a valid recommendation when claude returns a wrapped envelope", async () => {
    const claude = writeMockClaude(dir, { stdout: VALID_ENVELOPE });
    const result = await enrichOne(makeEntry(), {
      recommendationsPath: recPath,
      claudeBinary: claude,
      timeoutMs: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.wrote).toBe(true);
    expect(result.recommendation?.summary).toBe("Approve auto-rebase");
    expect(result.recommendation?.action.kind).toBe("approve_pr");

    const cache = readRecommendations(recPath);
    expect(cache.recommendations["entry-1"]?.summary).toBe("Approve auto-rebase");
  });

  it("accepts a bare-object output when no envelope is present", async () => {
    const claude = writeMockClaude(dir, { stdout: VALID_INNER_JSON });
    const result = await enrichOne(makeEntry(), {
      recommendationsPath: recPath,
      claudeBinary: claude,
      timeoutMs: 5_000,
    });
    expect(result.wrote).toBe(true);
  });

  it("uses the cache when input hash matches", async () => {
    const claude = writeMockClaude(dir, { stdout: VALID_ENVELOPE });
    const opts = {
      recommendationsPath: recPath,
      claudeBinary: claude,
      timeoutMs: 5_000,
    };
    const first = await enrichOne(makeEntry(), opts);
    expect(first.wrote).toBe(true);

    const second = await enrichOne(makeEntry(), opts);
    expect(second.wrote).toBe(false);
    expect(second.cacheHit).toBe(true);
  });

  it("regenerates when updated_at changes", async () => {
    const claude = writeMockClaude(dir, { stdout: VALID_ENVELOPE });
    const opts = {
      recommendationsPath: recPath,
      claudeBinary: claude,
      timeoutMs: 5_000,
    };
    await enrichOne(makeEntry({ updated_at: "2026-04-16T07:24:28Z" }), opts);
    const second = await enrichOne(makeEntry({ updated_at: "2026-04-16T08:00:00Z" }), opts);
    expect(second.wrote).toBe(true);
    expect(second.cacheHit).toBe(false);
  });

  it("rejects an action whose kind is not whitelisted", async () => {
    const bogus = JSON.stringify({
      summary: "...",
      rationale: "...",
      action: { kind: "rm_rf_home", args: { path: "/" } },
    });
    const claude = writeMockClaude(dir, {
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        result: bogus,
      }),
    });
    const result = await enrichOne(makeEntry(), {
      recommendationsPath: recPath,
      claudeBinary: claude,
      timeoutMs: 5_000,
    });
    expect(result.wrote).toBe(false);
    expect(result.error).toMatch(/schema validation/);
  });

  it("returns an error and does not write when claude exits non-zero", async () => {
    const claude = writeMockClaude(dir, {
      stdout: "",
      stderr: "boom",
      exitCode: 1,
    });
    const result = await enrichOne(makeEntry(), {
      recommendationsPath: recPath,
      claudeBinary: claude,
      timeoutMs: 5_000,
    });
    expect(result.wrote).toBe(false);
    expect(result.error).toMatch(/exited 1/);
    const cache = readRecommendations(recPath);
    expect(cache.recommendations).toEqual({});
  });

  it("returns an error when claude outputs non-JSON", async () => {
    const claude = writeMockClaude(dir, { stdout: "not json at all" });
    const result = await enrichOne(makeEntry(), {
      recommendationsPath: recPath,
      claudeBinary: claude,
      timeoutMs: 5_000,
    });
    expect(result.wrote).toBe(false);
    expect(result.error).toMatch(/not JSON|empty|schema/);
  });

  it("times out when claude hangs longer than timeoutMs", async () => {
    const claude = writeMockClaude(dir, {
      stdout: VALID_ENVELOPE,
      sleepSec: 2,
    });
    const result = await enrichOne(makeEntry(), {
      recommendationsPath: recPath,
      claudeBinary: claude,
      timeoutMs: 250,
    });
    expect(result.wrote).toBe(false);
    expect(result.error).toMatch(/timed out/);
  });
});

describe("enrichBatch", () => {
  let dir: string;
  let recPath: string;
  beforeEach(() => {
    dir = mkTmp();
    recPath = join(dir, "recommendations.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("only processes entries with status === human", async () => {
    const claude = writeMockClaude(dir, { stdout: VALID_ENVELOPE });
    const calls: string[] = [];
    const stats = await enrichBatch(
      [
        makeEntry({ id: "n1", github_scan_status: "new" }),
        makeEntry({ id: "h1" }),
        makeEntry({ id: "d1", github_scan_status: "done" }),
        makeEntry({ id: "h2" }),
      ],
      {
        recommendationsPath: recPath,
        claudeBinary: claude,
        timeoutMs: 5_000,
      },
      (rec) => calls.push(rec.id),
    );
    expect(stats.wrote).toBe(2);
    expect(stats.errors).toBe(0);
    expect(calls.sort()).toEqual(["h1", "h2"]);
  });
});
