/**
 * Auto-revert `github-scan:human` → `new` when the human comments back
 * (issue #358).
 *
 * Spec: when the daemon polls an item classified `human` and a qualifying
 * human comment is observed *after* the label was applied, the daemon
 * strips `github-scan:human` from the item. The classifier (which is
 * pure and unchanged) then derives `new` on the next cycle and the
 * dispatcher picks the item up.
 *
 * Guards (issue #358 acceptance criteria):
 *   1. Comment author MUST NOT be the agent itself (the daemon's identity).
 *   2. Comment body length > 20 chars (filters `👍`, `ok`, `thx`-only acks).
 *   3. Reactions alone do NOT count as a comment (callers pass real comments only).
 *   4. The comment's `created_at` MUST be strictly after the label's
 *      `created_at` / label-event timestamp.
 *
 * This module exposes:
 *   - `shouldAutoRevertHuman` — the pure decision function (testable in isolation).
 *   - `autoRevertHumanLabels` — the in-place label remover wired to a `GhClient`.
 *
 * No I/O happens in `shouldAutoRevertHuman`. The driver does all the
 * `gh` calls so unit tests can stub at the gh boundary.
 */

import type { GhClient } from "./gh.js";
import type { InboxEntry } from "./types.js";

/** Minimum body length (chars) for a comment to count as a real reply. */
export const AUTO_REVERT_MIN_BODY_CHARS = 20;

/** A single issue comment, as returned by `GET /repos/{r}/issues/{n}/comments`. */
export interface IssueComment {
  /** Comment author's GitHub login (case-insensitive when compared). */
  author: string;
  /** Raw markdown body. May be empty for reaction-only events (those are not comments). */
  body: string;
  /** ISO-8601 timestamp the comment was created at. */
  createdAt: string;
}

export interface AutoRevertInput {
  /** GitHub login of the daemon agent — comments authored by this login are ignored. */
  agentLogin: string;
  /** Timestamp the `github-scan:human` label was applied (ISO-8601). */
  labelAppliedAt: string;
  /** Comments on the item, in any order. */
  comments: readonly IssueComment[];
}

/**
 * Pure decision function: returns `true` when the item should have its
 * `github-scan:human` label removed.
 *
 * Returns `false` (and does nothing) when none of the comments pass all
 * four guards. See module docstring for the guard list.
 */
export function shouldAutoRevertHuman(input: AutoRevertInput): boolean {
  const labelTs = Date.parse(input.labelAppliedAt);
  if (Number.isNaN(labelTs)) return false;

  const agentLogin = input.agentLogin.toLowerCase();
  for (const comment of input.comments) {
    // Guard 1: own-comment ignored.
    if (comment.author.toLowerCase() === agentLogin) continue;

    // Guard 3: reactions alone do not count — callers pass only real
    // comments here, but we also defensively reject empty bodies.
    if (comment.body.length === 0) continue;

    // Guard 2: short ack ignored. Length is measured on the trimmed
    // body so trailing whitespace doesn't accidentally promote a "ok\n"
    // to a real reply.
    if (comment.body.trim().length <= AUTO_REVERT_MIN_BODY_CHARS) continue;

    // Guard 4: must be strictly after the label timestamp.
    const commentTs = Date.parse(comment.createdAt);
    if (Number.isNaN(commentTs)) continue;
    if (commentTs <= labelTs) continue;

    return true;
  }
  return false;
}

/**
 * Fetch comments for an issue/PR (number) via the REST API.
 *
 * Returns `null` on error so the caller can degrade gracefully — a
 * failed comment fetch should NEVER strip the label.
 */
export function fetchIssueComments(
  gh: GhClient,
  repo: string,
  number: number,
): IssueComment[] | null {
  const result = gh.run([
    "api",
    `/repos/${repo}/issues/${number}/comments?per_page=100`,
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
  ]);
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((raw): IssueComment | null => {
        if (typeof raw !== "object" || raw === null) return null;
        const r = raw as {
          user?: { login?: unknown } | null;
          body?: unknown;
          created_at?: unknown;
        };
        const login = r.user?.login;
        const body = r.body;
        const createdAt = r.created_at;
        if (typeof login !== "string") return null;
        if (typeof createdAt !== "string") return null;
        return {
          author: login,
          body: typeof body === "string" ? body : "",
          createdAt,
        };
      })
      .filter((c): c is IssueComment => c !== null);
  } catch {
    return null;
  }
}

/**
 * Find the most recent `github-scan:human` label-applied timestamp from
 * the issue timeline. Returns `null` on error or when the label has
 * never been applied (which should not happen if `entry.labels`
 * contains it, but we degrade gracefully).
 */
export function fetchHumanLabelAppliedAt(
  gh: GhClient,
  repo: string,
  number: number,
): string | null {
  const result = gh.run([
    "api",
    `/repos/${repo}/issues/${number}/timeline?per_page=100`,
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    "-H",
    "Accept: application/vnd.github.mockingbird-preview+json",
  ]);
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) return null;
    let latest: string | null = null;
    let latestMs = -Infinity;
    for (const raw of parsed) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as {
        event?: unknown;
        label?: { name?: unknown } | null;
        created_at?: unknown;
      };
      if (r.event !== "labeled") continue;
      const labelName = r.label?.name;
      if (labelName !== "github-scan:human") continue;
      if (typeof r.created_at !== "string") continue;
      const ms = Date.parse(r.created_at);
      if (Number.isNaN(ms)) continue;
      if (ms > latestMs) {
        latestMs = ms;
        latest = r.created_at;
      }
    }
    return latest;
  } catch {
    return null;
  }
}

export interface AutoRevertDeps {
  gh: GhClient;
  agentLogin: string;
  /** Test seam: override comment-fetch (default uses `fetchIssueComments`). */
  fetchComments?: (gh: GhClient, repo: string, number: number) => IssueComment[] | null;
  /** Test seam: override timeline-fetch. */
  fetchLabelAppliedAt?: (gh: GhClient, repo: string, number: number) => string | null;
}

export interface AutoRevertOutcome {
  /** ids of entries whose `github-scan:human` label was successfully removed. */
  reverted: string[];
  /** Non-fatal warnings (failed fetches, etc). */
  warnings: string[];
}

/**
 * Iterate `entries` looking for items currently labeled
 * `github-scan:human`. For each, fetch the label-event timestamp and
 * the comment list, apply the four guards, and — when they pass —
 * remove the label both via `gh.removeLabel` and from the in-memory
 * `entry.labels` array.
 *
 * Mutates entries in place when reverting so the subsequent
 * `classifyEntries` call naturally derives `new` for them.
 *
 * Spec note: this runs once per poll cycle. The poller keeps a per-id
 * tombstone (`reverted`) only for the duration of a single cycle —
 * there is no race within a cycle because we mutate `entry.labels` and
 * then classify. On the *next* cycle, GraphQL re-reads the live label
 * set, which will no longer contain `github-scan:human`, so we will
 * not retry.
 */
export function autoRevertHumanLabels(
  entries: InboxEntry[],
  deps: AutoRevertDeps,
): AutoRevertOutcome {
  const fetchComments = deps.fetchComments ?? fetchIssueComments;
  const fetchLabelAppliedAt = deps.fetchLabelAppliedAt ?? fetchHumanLabelAppliedAt;

  const reverted: string[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    if (entry.number === null) continue;
    if (!entry.labels.includes("github-scan:human")) continue;

    const labelAppliedAt = fetchLabelAppliedAt(deps.gh, entry.repo, entry.number);
    if (!labelAppliedAt) {
      warnings.push(
        `auto-revert: missing label-applied timestamp for ${entry.repo}#${entry.number}`,
      );
      continue;
    }

    const comments = fetchComments(deps.gh, entry.repo, entry.number);
    if (!comments) {
      warnings.push(`auto-revert: comment fetch failed for ${entry.repo}#${entry.number}`);
      continue;
    }

    const decide = shouldAutoRevertHuman({
      agentLogin: deps.agentLogin,
      labelAppliedAt,
      comments,
    });
    if (!decide) continue;

    deps.gh.removeLabel(entry.repo, entry.number, "github-scan:human");
    entry.labels = entry.labels.filter((l) => l !== "github-scan:human");
    reverted.push(entry.id);
  }

  return { reverted, warnings };
}
