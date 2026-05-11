/**
 * Runtime-validated types for the shared github-scan store.
 *
 * Authoritative spec: the inbox/activity-log schema (historical migration doc, now removed; see git history) and
 * the status state-machine spec (historical migration doc, now removed; see git history). These must round-trip
 * existing `~/.first-tree/github-scan/inbox.json` and `~/.first-tree/github-scan/activity.log` files
 * produced by the Rust `github-scan-runner` and the legacy bash scripts.
 *
 * Field ordering and `null` (vs `undefined` / omitted) in inbox entries
 * is load-bearing — the Rust encoder always emits every key and uses
 * JSON `null` for nullable fields. Matching ordering (spec doc 2 §1.1)
 * keeps diffs human-readable when inspecting live files.
 */

import { z } from "zod";

/** The four possible derived statuses for a notification. */
export const GitHubScanStatusSchema = z.enum(["new", "wip", "human", "done"]);
export type GitHubScanStatus = z.infer<typeof GitHubScanStatusSchema>;

/** GitHub GraphQL `state` enum surfaced in the inbox payload. */
export const GhStateSchema = z.enum(["OPEN", "CLOSED", "MERGED"]);
export type GhState = z.infer<typeof GhStateSchema>;

/**
 * Single inbox entry. Matches `entry_to_json` in
 * `fetcher.rs:601-631`.
 *
 * The encoder never omits keys; nullable fields are emitted as JSON `null`.
 */
export const InboxEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  reason: z.string(),
  repo: z.string(),
  title: z.string(),
  url: z.string(),
  last_actor: z.string(),
  updated_at: z.string(),
  unread: z.boolean(),
  priority: z.number().int(),
  number: z.number().int().nullable(),
  html_url: z.string(),
  gh_state: GhStateSchema.nullable(),
  labels: z.array(z.string()),
  github_scan_status: GitHubScanStatusSchema,
});
export type InboxEntry = z.infer<typeof InboxEntrySchema>;

/** Top-level `inbox.json` shape. */
export const InboxSchema = z.object({
  last_poll: z.string(),
  notifications: z.array(InboxEntrySchema),
});
export type Inbox = z.infer<typeof InboxSchema>;

/**
 * Activity-log event kinds emitted by the Rust fetcher and the shell
 * status-manager. Spec doc 2 §2.
 *
 * The four observed kinds in the wild:
 *   - `new` — fetcher: first-time notification
 *   - `transition` — fetcher or status-manager: github_scan_status changed
 *   - `claimed` — status-manager: claim directory acquired
 *   - `poll` — legacy `bin/github-scan-poll`: count-of-new per cycle
 *
 * Each event has a small common header (`ts`, `event`, plus per-kind
 * payload). Extra keys are allowed for forward-compatibility but
 * validated for type where present.
 */
const CommonHeader = {
  ts: z.string(),
  id: z.string(),
  type: z.string(),
  repo: z.string(),
  title: z.string(),
  url: z.string(),
};

export const NewEventSchema = z.object({
  event: z.literal("new"),
  ...CommonHeader,
});
export type NewEvent = z.infer<typeof NewEventSchema>;

export const TransitionEventSchema = z.object({
  event: z.literal("transition"),
  ...CommonHeader,
  from: GitHubScanStatusSchema,
  to: GitHubScanStatusSchema,
  // Status-manager writes these extra fields; the Rust fetcher does not.
  by: z.string().optional(),
  reason: z.string().optional(),
});
export type TransitionEvent = z.infer<typeof TransitionEventSchema>;

export const ClaimedEventSchema = z.object({
  event: z.literal("claimed"),
  ...CommonHeader,
  by: z.string(),
  action: z.string(),
});
export type ClaimedEvent = z.infer<typeof ClaimedEventSchema>;

export const PollEventSchema = z.object({
  event: z.literal("poll"),
  ts: z.string(),
  count: z.number().int(),
});
export type PollEvent = z.infer<typeof PollEventSchema>;

export const ActivityEventSchema = z.union([
  NewEventSchema,
  TransitionEventSchema,
  ClaimedEventSchema,
  PollEventSchema,
]);
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

/** Claim directory contents (one subdirectory per notification id). */
export const ClaimSchema = z.object({
  claimed_by: z.string(),
  claimed_at: z.string(),
  action: z.string(),
});
export type Claim = z.infer<typeof ClaimSchema>;

/**
 * Label color/description metadata enforced by `ensure-labels` on a repo.
 * Spec doc 3 §7.
 */
export const GITHUB_SCAN_LABEL_META = {
  "github-scan:new": { color: "0075ca", description: "GitHub Scan: new notification" },
  "github-scan:wip": { color: "e4e669", description: "GitHub Scan: work in progress" },
  "github-scan:human": {
    color: "d93f0b",
    description: "GitHub Scan: needs human attention",
  },
  "github-scan:done": { color: "0e8a16", description: "GitHub Scan: handled" },
} as const satisfies Record<string, { color: string; description: string }>;

export const ALL_GITHUB_SCAN_LABELS = [
  "github-scan:new",
  "github-scan:wip",
  "github-scan:human",
  "github-scan:done",
] as const;
export type GitHubScanLabel = (typeof ALL_GITHUB_SCAN_LABELS)[number];

/**
 * Island feature: structured action recommendations.
 *
 * The LLM enrichment worker produces one of these per `human` inbox entry.
 * The schema is intentionally narrow — only whitelisted action kinds may be
 * produced or executed. Anything else is rejected at parse time, so even a
 * prompt-injected LLM cannot make the tray shell out to arbitrary commands.
 *
 * Args are validated per-kind; the dispatcher passes them as a `Process`
 * argv array (never string-concatenated into a shell), so injection in
 * comment/body fields is rendered harmless.
 *
 * See [`docs/island-design.md`](../../../../../../README.md) and
 * `serenakeyitan/first-tree#3` for the full design.
 */

const ApprovePrArgs = z.object({
  pr_number: z.number().int().positive(),
  comment: z.string().max(2000).default(""),
});

const CommentArgs = z.object({
  /** PR or Issue number. */
  number: z.number().int().positive(),
  /** Whether the parent is a PR or an issue. Affects the gh subcommand. */
  target: z.enum(["pr", "issue"]),
  body: z.string().min(1).max(20_000),
});

const CloseIssueArgs = z.object({
  issue_number: z.number().int().positive(),
  comment: z.string().max(2000).default(""),
});

const RequestChangesArgs = z.object({
  pr_number: z.number().int().positive(),
  body: z.string().min(1).max(20_000),
});

export const ActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve_pr"), args: ApprovePrArgs }),
  z.object({ kind: z.literal("comment"), args: CommentArgs }),
  z.object({ kind: z.literal("close_issue"), args: CloseIssueArgs }),
  z.object({ kind: z.literal("request_changes"), args: RequestChangesArgs }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const ALL_ACTION_KINDS = [
  "approve_pr",
  "comment",
  "close_issue",
  "request_changes",
] as const satisfies ReadonlyArray<Action["kind"]>;

export const RecommendationSchema = z.object({
  /** The inbox entry this recommendation is for (matches InboxEntry.id). */
  id: z.string(),
  /** One-line UI summary, e.g. "Approve auto-rebase". */
  summary: z.string().min(1).max(200),
  /** Why the LLM chose this — shown on hover or in the expanded view. */
  rationale: z.string().max(2000),
  /** The structured, whitelisted action. */
  action: ActionSchema,
  /** Unix epoch (seconds) when the recommendation was generated. */
  generated_at: z.number().int().nonnegative(),
  /** Model identifier, e.g. "claude-sonnet-4-5". For cache invalidation. */
  model: z.string(),
  /**
   * Hash of the input the LLM saw (entry id + updated_at). When the inbox
   * entry's `updated_at` changes, the cache is stale and we re-enrich.
   */
  input_hash: z.string(),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

/** Top-level shape of `recommendations.json`. */
export const RecommendationCacheSchema = z.object({
  /** Cache schema version — bump if we ever change the layout. */
  version: z.literal(1),
  /** Map from inbox entry id → recommendation. */
  recommendations: z.record(z.string(), RecommendationSchema),
});
export type RecommendationCache = z.infer<typeof RecommendationCacheSchema>;
