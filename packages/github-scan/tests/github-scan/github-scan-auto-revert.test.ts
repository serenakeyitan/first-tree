/**
 * Issue #358 acceptance-criteria tests for the `github-scan:human`
 * auto-revert logic.
 *
 * The five required cases from the issue:
 *   (a) own-comment ignored
 *   (b) short ack ignored
 *   (c) reaction ignored
 *   (d) genuine reply triggers revert
 *   (e) pre-label comment does NOT trigger revert
 *
 * The pure decision function (`shouldAutoRevertHuman`) is exercised
 * directly. The driver (`autoRevertHumanLabels`) gets one end-to-end
 * test that the gh.removeLabel + entry.labels mutation actually fire
 * for case (d) — the same code path that production uses.
 */

import { describe, expect, it, vi } from "vitest";

import {
  AUTO_REVERT_MAX_PAGES,
  AUTO_REVERT_PAGE_SIZE,
  autoRevertHumanLabels,
  fetchHumanLabelAppliedAt,
  fetchIssueComments,
  shouldAutoRevertHuman,
  type IssueComment,
} from "../../src/github-scan/engine/runtime/auto-revert.js";
import type { GhClient, GhExecResult } from "../../src/github-scan/engine/runtime/gh.js";
import type { InboxEntry } from "../../src/github-scan/engine/runtime/types.js";

const AGENT = "first-tree-bot";
const LABEL_TS = "2026-04-30T10:00:00Z";

function makeEntry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: "n-1",
    type: "Issue",
    reason: "mention",
    repo: "agent-team-foundation/first-tree",
    title: "test",
    url: "https://api.github.com/...",
    last_actor: "alice",
    updated_at: "2026-04-30T11:00:00Z",
    unread: true,
    priority: 0,
    number: 42,
    html_url: "https://github.com/agent-team-foundation/first-tree/issues/42",
    gh_state: "OPEN",
    labels: ["github-scan:human"],
    github_scan_status: "human",
    ...overrides,
  };
}

describe("shouldAutoRevertHuman — issue #358 guards", () => {
  it("(a) own-comment ignored: a long post-label comment by the agent does not trigger revert", () => {
    const comments: IssueComment[] = [
      {
        author: AGENT,
        body: "Following up: I'll continue once the human weighs in.",
        createdAt: "2026-04-30T11:00:00Z",
      },
    ];
    expect(
      shouldAutoRevertHuman({
        agentLogin: AGENT,
        labelAppliedAt: LABEL_TS,
        comments,
      }),
    ).toBe(false);
  });

  it("(b) short ack ignored: a 'ok thx' post-label human reply does not trigger revert", () => {
    const comments: IssueComment[] = [
      {
        author: "alice",
        body: "ok thx",
        createdAt: "2026-04-30T11:00:00Z",
      },
      {
        author: "alice",
        body: "👍",
        createdAt: "2026-04-30T11:01:00Z",
      },
    ];
    expect(
      shouldAutoRevertHuman({
        agentLogin: AGENT,
        labelAppliedAt: LABEL_TS,
        comments,
      }),
    ).toBe(false);
  });

  it("(c) reaction ignored: a comment with empty body (the shape we'd see for a reaction-only event if it leaked through) does not trigger revert", () => {
    const comments: IssueComment[] = [
      {
        author: "alice",
        body: "",
        createdAt: "2026-04-30T11:00:00Z",
      },
    ];
    expect(
      shouldAutoRevertHuman({
        agentLogin: AGENT,
        labelAppliedAt: LABEL_TS,
        comments,
      }),
    ).toBe(false);
  });

  it("(d) genuine reply triggers revert: a >20-char post-label human comment triggers revert", () => {
    const comments: IssueComment[] = [
      {
        author: "alice",
        body: "Go ahead with option A — please proceed and ping me if you hit anything weird.",
        createdAt: "2026-04-30T11:00:00Z",
      },
    ];
    expect(
      shouldAutoRevertHuman({
        agentLogin: AGENT,
        labelAppliedAt: LABEL_TS,
        comments,
      }),
    ).toBe(true);
  });

  it("(e) pre-label comment does NOT trigger revert: a long human comment posted strictly before the label was applied is ignored", () => {
    const comments: IssueComment[] = [
      {
        author: "alice",
        body: "I really am not sure what to do here, I might need to escalate this.",
        // Strictly before LABEL_TS = 10:00:00Z.
        createdAt: "2026-04-30T09:59:59Z",
      },
    ];
    expect(
      shouldAutoRevertHuman({
        agentLogin: AGENT,
        labelAppliedAt: LABEL_TS,
        comments,
      }),
    ).toBe(false);
  });

  it("comment exactly at the label timestamp is NOT considered after (strict inequality)", () => {
    const comments: IssueComment[] = [
      {
        author: "alice",
        body: "Plenty of words here to be a real reply, definitely longer than 20 chars.",
        createdAt: LABEL_TS,
      },
    ];
    expect(
      shouldAutoRevertHuman({
        agentLogin: AGENT,
        labelAppliedAt: LABEL_TS,
        comments,
      }),
    ).toBe(false);
  });

  it("(issue #360) own-comment guard uses the *resolved* agent identity, not the daemon's gh auth user", () => {
    // Scenario: the daemon is authed as `serenakeyitan` (operator) but
    // is configured with `--agent-login first-tree-bot`. The operator
    // (under their own gh login) leaves a real reply on the labeled
    // item. Since the resolved agent identity is `first-tree-bot`, the
    // operator's comment must NOT be filtered as own-comment, and the
    // revert must fire.
    const comments: IssueComment[] = [
      {
        author: "serenakeyitan",
        body: "Please proceed with option A — confirmed in office hours, go ahead.",
        createdAt: "2026-04-30T11:05:00Z",
      },
    ];
    expect(
      shouldAutoRevertHuman({
        agentLogin: "first-tree-bot", // resolved identity, NOT the gh auth user
        labelAppliedAt: LABEL_TS,
        comments,
      }),
    ).toBe(true);
  });

  it("agent-login comparison is case-insensitive (GitHub logins are case-insensitive)", () => {
    const comments: IssueComment[] = [
      {
        author: "First-Tree-Bot",
        body: "This is an agent comment and should be ignored even with mixed casing.",
        createdAt: "2026-04-30T11:00:00Z",
      },
    ];
    expect(
      shouldAutoRevertHuman({
        agentLogin: "first-tree-bot",
        labelAppliedAt: LABEL_TS,
        comments,
      }),
    ).toBe(false);
  });
});

describe("autoRevertHumanLabels — driver", () => {
  it("strips github-scan:human via gh.removeLabel and mutates entry.labels in place when guards pass", () => {
    const removeLabel = vi.fn().mockReturnValue(true);
    const stubGh = { removeLabel } as unknown as GhClient;
    const entry = makeEntry();

    const out = autoRevertHumanLabels([entry], {
      gh: stubGh,
      agentLogin: AGENT,
      fetchLabelAppliedAt: () => LABEL_TS,
      fetchComments: () => [
        {
          author: "alice",
          body: "Go ahead with option A — please proceed and ping me if you hit anything weird.",
          createdAt: "2026-04-30T11:00:00Z",
        },
      ],
    });

    expect(removeLabel).toHaveBeenCalledTimes(1);
    expect(removeLabel).toHaveBeenCalledWith(
      "agent-team-foundation/first-tree",
      42,
      "github-scan:human",
    );
    expect(entry.labels).not.toContain("github-scan:human");
    expect(out.reverted).toEqual(["n-1"]);
    expect(out.warnings).toEqual([]);
  });

  it("does not strip the label when guards fail (own-comment)", () => {
    const removeLabel = vi.fn();
    const stubGh = { removeLabel } as unknown as GhClient;
    const entry = makeEntry();

    const out = autoRevertHumanLabels([entry], {
      gh: stubGh,
      agentLogin: AGENT,
      fetchLabelAppliedAt: () => LABEL_TS,
      fetchComments: () => [
        {
          author: AGENT,
          body: "Posted long-form by the agent, should never count as a human reply.",
          createdAt: "2026-04-30T11:00:00Z",
        },
      ],
    });

    expect(removeLabel).not.toHaveBeenCalled();
    expect(entry.labels).toContain("github-scan:human");
    expect(out.reverted).toEqual([]);
  });

  it("skips items not labeled github-scan:human", () => {
    const removeLabel = vi.fn();
    const stubGh = { removeLabel } as unknown as GhClient;
    const entry = makeEntry({
      labels: ["github-scan:wip"],
      github_scan_status: "wip",
    });

    const out = autoRevertHumanLabels([entry], {
      gh: stubGh,
      agentLogin: AGENT,
      fetchLabelAppliedAt: () => LABEL_TS,
      fetchComments: () => {
        throw new Error("should not fetch comments for non-human items");
      },
    });

    expect(removeLabel).not.toHaveBeenCalled();
    expect(out.reverted).toEqual([]);
  });

  it("does not mutate entry.labels or record a revert when gh.removeLabel fails (issue #364)", () => {
    // Simulate a transient `gh` API failure: removeLabel returns false.
    // Local inbox state must not drift from GitHub's truth — the daemon
    // should leave the label in place and emit a warning so the next
    // poll cycle retries naturally.
    const removeLabel = vi.fn().mockReturnValue(false);
    const stubGh = { removeLabel } as unknown as GhClient;
    const entry = makeEntry();

    const out = autoRevertHumanLabels([entry], {
      gh: stubGh,
      agentLogin: AGENT,
      fetchLabelAppliedAt: () => LABEL_TS,
      fetchComments: () => [
        {
          author: "alice",
          body: "Go ahead with option A — please proceed and ping me if you hit anything weird.",
          createdAt: "2026-04-30T11:00:00Z",
        },
      ],
    });

    expect(removeLabel).toHaveBeenCalledTimes(1);
    expect(entry.labels).toContain("github-scan:human");
    expect(out.reverted).toEqual([]);
    expect(out.warnings.length).toBe(1);
    expect(out.warnings[0]).toMatch(/removeLabel failed/);
  });

  it("warns and skips when the label-event timestamp cannot be fetched (degrades safely)", () => {
    const removeLabel = vi.fn();
    const stubGh = { removeLabel } as unknown as GhClient;
    const entry = makeEntry();

    const out = autoRevertHumanLabels([entry], {
      gh: stubGh,
      agentLogin: AGENT,
      fetchLabelAppliedAt: () => null,
      fetchComments: () => [],
    });

    expect(removeLabel).not.toHaveBeenCalled();
    expect(entry.labels).toContain("github-scan:human");
    expect(out.warnings.length).toBe(1);
  });
});

/**
 * Pagination tests (issue #365).
 *
 * The previous implementations only fetched page 1, so on long-lived
 * issues (>100 timeline events / >100 comments) the relevant signal
 * could fall off page 1 and auto-revert silently failed. These tests
 * stub `gh.run` page-by-page and confirm:
 *
 *   - 0-page (empty) returns the natural empty/null result
 *   - 1-page (existing single-page behaviour preserved)
 *   - 2-page (label event lives on page 2 and is found)
 *   - 3-page (post-label comment on page 3 from desc walk works the
 *     other way around: a post-label comment is on the *first* page in
 *     desc order; we exercise the multi-page accumulation case where
 *     pages 1-2 are post-label and page 3 is pre-label)
 *   - early-exit fires for comments (page 3 is not fetched once page 2's
 *     newest comment is at-or-before the label timestamp)
 *   - hard-cap warning fires when timeline has > MAX_PAGES full pages
 */
describe("fetchHumanLabelAppliedAt — pagination (issue #365)", () => {
  function makeRunStub(pages: readonly unknown[][]): {
    run: (args: readonly string[]) => GhExecResult;
    calls: number;
  } {
    const state = { calls: 0 };
    const run = (args: readonly string[]): GhExecResult => {
      state.calls++;
      const url = args[1] ?? "";
      const match = /[?&]page=(\d+)/.exec(url);
      const page = match ? Number.parseInt(match[1]!, 10) : 1;
      const body = pages[page - 1] ?? [];
      return { status: 0, stdout: JSON.stringify(body), stderr: "" };
    };
    return {
      run,
      get calls() {
        return state.calls;
      },
    } as unknown as {
      run: (args: readonly string[]) => GhExecResult;
      calls: number;
    };
  }

  it("0-page (empty timeline): returns null and stops after one fetch", () => {
    const stub = makeRunStub([[]]);
    const gh = { run: stub.run } as unknown as GhClient;
    expect(fetchHumanLabelAppliedAt(gh, "o/r", 1)).toBeNull();
    expect(stub.calls).toBe(1);
  });

  it("1-page: short page (< per_page) stops after one fetch and returns the latest label timestamp", () => {
    const labeledEvent = {
      event: "labeled",
      label: { name: "github-scan:human" },
      created_at: "2026-04-30T10:00:00Z",
    };
    const stub = makeRunStub([[labeledEvent, { event: "commented" }]]);
    const gh = { run: stub.run } as unknown as GhClient;
    expect(fetchHumanLabelAppliedAt(gh, "o/r", 1)).toBe("2026-04-30T10:00:00Z");
    expect(stub.calls).toBe(1);
  });

  it("2-page: label-event on page 2 is found", () => {
    const fillerPage1 = Array.from({ length: AUTO_REVERT_PAGE_SIZE }, (_, i) => ({
      event: "commented",
      created_at: `2026-04-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
    }));
    const labeledOnPage2 = {
      event: "labeled",
      label: { name: "github-scan:human" },
      created_at: "2026-04-30T10:00:00Z",
    };
    const stub = makeRunStub([fillerPage1, [labeledOnPage2]]);
    const gh = { run: stub.run } as unknown as GhClient;
    expect(fetchHumanLabelAppliedAt(gh, "o/r", 1)).toBe("2026-04-30T10:00:00Z");
    expect(stub.calls).toBe(2);
  });

  it("hard-cap engages on > MAX_PAGES full pages and emits a console.warn", () => {
    // Every page returns a full page so pagination never naturally ends.
    const fullPage = Array.from({ length: AUTO_REVERT_PAGE_SIZE }, () => ({
      event: "commented",
      created_at: "2026-04-01T00:00:00Z",
    }));
    let calls = 0;
    const gh = {
      run: () => {
        calls++;
        return { status: 0, stdout: JSON.stringify(fullPage), stderr: "" };
      },
    } as unknown as GhClient;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fetchHumanLabelAppliedAt(gh, "o/r", 1);
      expect(calls).toBe(AUTO_REVERT_MAX_PAGES);
      // The warn is emitted on the final page (the cap notice).
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/cap/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("fetchIssueComments — pagination (issue #365)", () => {
  function commentRaw(login: string, body: string, createdAt: string): unknown {
    return { user: { login }, body, created_at: createdAt };
  }

  function makeRunStub(pages: readonly unknown[][]) {
    const state = { calls: 0, requestedPages: [] as number[] };
    const run = (args: readonly string[]): GhExecResult => {
      state.calls++;
      const url = args[1] ?? "";
      const match = /[?&]page=(\d+)/.exec(url);
      const page = match ? Number.parseInt(match[1]!, 10) : 1;
      state.requestedPages.push(page);
      const body = pages[page - 1] ?? [];
      return { status: 0, stdout: JSON.stringify(body), stderr: "" };
    };
    return { run, state };
  }

  it("0-page (empty comments): returns []", () => {
    const stub = makeRunStub([[]]);
    const gh = { run: stub.run } as unknown as GhClient;
    expect(fetchIssueComments(gh, "o/r", 1)).toEqual([]);
    expect(stub.state.calls).toBe(1);
  });

  it("1-page (short page): existing single-page behaviour preserved", () => {
    const stub = makeRunStub([[commentRaw("alice", "hi there", "2026-04-30T11:00:00Z")]]);
    const gh = { run: stub.run } as unknown as GhClient;
    const out = fetchIssueComments(gh, "o/r", 1);
    expect(out).toEqual([{ author: "alice", body: "hi there", createdAt: "2026-04-30T11:00:00Z" }]);
    expect(stub.state.calls).toBe(1);
  });

  it("3-page accumulation: walks pages until natural short-page end (no labelAppliedAt provided)", () => {
    const fullPage1 = Array.from({ length: AUTO_REVERT_PAGE_SIZE }, (_, i) =>
      commentRaw(
        "u",
        `body ${i} long enough`,
        `2026-04-30T11:${String(i % 60).padStart(2, "0")}:00Z`,
      ),
    );
    const fullPage2 = Array.from({ length: AUTO_REVERT_PAGE_SIZE }, (_, i) =>
      commentRaw(
        "u",
        `body p2 ${i} long enough`,
        `2026-04-29T11:${String(i % 60).padStart(2, "0")}:00Z`,
      ),
    );
    const shortPage3 = [
      commentRaw("alice", "tail comment that is plenty long here", "2026-04-28T10:00:00Z"),
    ];
    const stub = makeRunStub([fullPage1, fullPage2, shortPage3]);
    const gh = { run: stub.run } as unknown as GhClient;
    const out = fetchIssueComments(gh, "o/r", 1);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(AUTO_REVERT_PAGE_SIZE * 2 + 1);
    expect(stub.state.calls).toBe(3);
  });

  it("early-exit fires: page 2's newest comment is older than labelAppliedAt — page 3 is not fetched", () => {
    const labelAppliedAt = "2026-04-30T10:00:00Z";
    // Page 1: full page of post-label comments (newest first).
    const fullPage1 = Array.from({ length: AUTO_REVERT_PAGE_SIZE }, (_, i) =>
      commentRaw(
        "u",
        `post-label ${i} long enough body`,
        `2026-04-30T11:${String(i % 60).padStart(2, "0")}:00Z`,
      ),
    );
    // Page 2: full page where the FIRST (newest) comment is already pre-label.
    const fullPage2 = Array.from({ length: AUTO_REVERT_PAGE_SIZE }, (_, i) =>
      commentRaw(
        "u",
        `pre-label ${i} long enough body`,
        `2026-04-29T11:${String(i % 60).padStart(2, "0")}:00Z`,
      ),
    );
    // Page 3 should never be requested. Make it explode if it is.
    const stub = makeRunStub([fullPage1, fullPage2]);
    const explodingRun = (args: readonly string[]): GhExecResult => {
      const result = stub.run(args);
      const url = args[1] ?? "";
      const match = /[?&]page=(\d+)/.exec(url);
      const page = match ? Number.parseInt(match[1]!, 10) : 1;
      if (page >= 3) throw new Error("page 3 should not be fetched (early-exit failed)");
      return result;
    };
    const gh = { run: explodingRun } as unknown as GhClient;
    const out = fetchIssueComments(gh, "o/r", 1, labelAppliedAt);
    expect(out).not.toBeNull();
    // Page 1 is accumulated; page 2 is fetched but early-exit fires
    // BEFORE its (entirely pre-label) comments are pushed, so they're
    // not wastefully accumulated just to be filtered downstream.
    expect(out!.length).toBe(AUTO_REVERT_PAGE_SIZE);
    expect(stub.state.requestedPages).toEqual([1, 2]);
  });

  it("post-label comment on page 3: when no early-exit (label is older than every page), pagination continues across 3 pages", () => {
    // labelAppliedAt is older than every comment, so early-exit never fires
    // and we walk to the natural short-page terminator on page 3.
    const labelAppliedAt = "2026-01-01T00:00:00Z";
    const fullPage1 = Array.from({ length: AUTO_REVERT_PAGE_SIZE }, (_, i) =>
      commentRaw(
        "u",
        `body ${i} long enough body`,
        `2026-04-30T11:${String(i % 60).padStart(2, "0")}:00Z`,
      ),
    );
    const fullPage2 = Array.from({ length: AUTO_REVERT_PAGE_SIZE }, (_, i) =>
      commentRaw(
        "u",
        `body p2 ${i} long enough`,
        `2026-03-30T11:${String(i % 60).padStart(2, "0")}:00Z`,
      ),
    );
    // The "post-label comment on page 3" — found, not skipped.
    const shortPage3 = [
      commentRaw(
        "alice",
        "Final-page comment that is genuinely long enough to count.",
        "2026-02-01T10:00:00Z",
      ),
    ];
    const stub = makeRunStub([fullPage1, fullPage2, shortPage3]);
    const gh = { run: stub.run } as unknown as GhClient;
    const out = fetchIssueComments(gh, "o/r", 1, labelAppliedAt);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(AUTO_REVERT_PAGE_SIZE * 2 + 1);
    expect(stub.state.calls).toBe(3);
    expect(out![out!.length - 1]!.createdAt).toBe("2026-02-01T10:00:00Z");
  });

  it("hard-cap engages on > MAX_PAGES full pages and emits a console.warn", () => {
    const fullPage = Array.from({ length: AUTO_REVERT_PAGE_SIZE }, (_, i) =>
      commentRaw("u", `body ${i} long enough body`, "2026-04-30T11:00:00Z"),
    );
    let calls = 0;
    const gh = {
      run: () => {
        calls++;
        return { status: 0, stdout: JSON.stringify(fullPage), stderr: "" };
      },
    } as unknown as GhClient;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fetchIssueComments(gh, "o/r", 1);
      expect(calls).toBe(AUTO_REVERT_MAX_PAGES);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/cap/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
