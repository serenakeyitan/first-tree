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
  autoRevertHumanLabels,
  shouldAutoRevertHuman,
  type IssueComment,
} from "../../src/github-scan/engine/runtime/auto-revert.js";
import type { GhClient } from "../../src/github-scan/engine/runtime/gh.js";
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
    const removeLabel = vi.fn();
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
