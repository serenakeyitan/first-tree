import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { Repo } from "#engine/repo.js";
import {
  TREE_RUNTIME_ROOT,
} from "#engine/runtime/asset-loader.js";
import {
  listTreeBindings,
  slugifyToken,
  writeTreeBinding,
  type TreeBindingState,
} from "#engine/runtime/binding-state.js";

const execFileAsync = promisify(execFile);

export const RECONCILE_USAGE = `usage: first-tree reconcile [--tree-path PATH] [--source ID] [--propose] [--apply] [--dry-run]

Detect drift between a Context Tree and the source repo(s) it describes.
Runs in three phases controlled by flags:

  default        Detect drift only. Prints a summary. Exits 0.
  --propose      Detect + write proposal files under .first-tree/proposals/.
  --apply        Detect + propose + write new tree files, commit, push,
                 and open a PR labeled \`first-tree:reconcile\` + \`auto-merge\`.

First-run policy: if a binding has no \`lastReconciledSourceCommit\`, the
command pins it to the current source HEAD without writing any proposals.

Requires the \`gh\` CLI to be authenticated. Drift classification calls the
\`claude\` CLI if it is on PATH; otherwise falls back to a deterministic
grouping by top-level directory.

Options:
  --tree-path PATH    Reconcile a tree repo from another working directory
  --source ID         Only reconcile a single bound source by sourceId
  --propose           Write proposal files under .first-tree/proposals/
  --apply             Apply proposals, open PR (implies --propose)
  --dry-run           With --apply, skip \`git push\` and \`gh pr create\`
  --help              Show this help message
`;

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ShellRun = (
  command: string,
  args: string[],
  options?: { cwd?: string; input?: string },
) => Promise<ShellResult>;

export interface ReconcileDeps {
  shellRun?: ShellRun;
  now?: () => Date;
}

async function defaultShellRun(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string } = {},
): Promise<ShellResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
    };
    const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString() ?? "";
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? "";
    const code = typeof e.code === "number" ? e.code : 1;
    return { stdout, stderr, code };
  }
}

interface OwnerRepo {
  owner: string;
  repo: string;
}

export function parseOwnerRepoFromRemoteUrl(url: string): OwnerRepo | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[2], repo: sshMatch[3] };
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const parsed = new URL(trimmed);
      const parts = parsed.pathname
        .replace(/^\/+/, "")
        .replace(/\.git$/, "")
        .split("/");
      if (parts.length >= 2 && parts[0] !== "" && parts[1] !== "") {
        return { owner: parts[0], repo: parts[1] };
      }
    } catch {
      return null;
    }
  }
  return null;
}

export interface TreeNodeSummary {
  path: string;
  title: string | undefined;
  owners: string[] | undefined;
}

const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".first-tree",
  ".agents",
  ".claude",
  "dist",
  "build",
]);

const FRONTMATTER_RE = /^---\s*\n(.*?)\n---/s;
const TITLE_RE = /^title:\s*['"]?(.+?)['"]?\s*$/m;
const OWNERS_RE = /^owners:\s*\[([^\]]*)\]/m;

function parseNodeFrontmatter(text: string): {
  title: string | undefined;
  owners: string[] | undefined;
} {
  const match = text.match(FRONTMATTER_RE);
  if (!match) return { title: undefined, owners: undefined };
  const fm = match[1];
  const titleMatch = fm.match(TITLE_RE);
  const ownersMatch = fm.match(OWNERS_RE);
  const title = titleMatch ? titleMatch[1].trim() : undefined;
  let owners: string[] | undefined;
  if (ownersMatch) {
    const raw = ownersMatch[1].trim();
    owners = raw === ""
      ? []
      : raw.split(",").map((o) => o.trim()).filter(Boolean);
  }
  return { title, owners };
}

export function scanTreeNodes(root: string): TreeNodeSummary[] {
  const results: TreeNodeSummary[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SCAN_SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && entry === "NODE.md") {
        try {
          const text = readFileSync(full, "utf-8");
          const { title, owners } = parseNodeFrontmatter(text);
          results.push({
            path: relative(root, full).split("\\").join("/"),
            title,
            owners,
          });
        } catch {
          // ignore unreadable files
        }
      }
    }
  };
  walk(root);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

interface CommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
  topDir: string;
}

interface DriftReport {
  binding: TreeBindingState;
  ownerRepo: OwnerRepo;
  fromSha: string | null;
  toSha: string;
  commits: CommitSummary[];
  mergedPrTitles: string[];
  truncated: boolean;
}

interface ClassificationItem {
  path: string;
  type: "TREE_MISS" | "TREE_STALE" | "TREE_OK";
  target_node_path: string | null;
  rationale: string;
  suggested_node_title: string;
  suggested_node_body_markdown: string;
}

interface ParsedFlags {
  help: boolean;
  treePath: string | undefined;
  source: string | undefined;
  propose: boolean;
  apply: boolean;
  dryRun: boolean;
  unknown: string | undefined;
}

function parseFlags(args: string[]): ParsedFlags {
  const result: ParsedFlags = {
    help: false,
    treePath: undefined,
    source: undefined,
    propose: false,
    apply: false,
    dryRun: false,
    unknown: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--tree-path") {
      const value = args[index + 1];
      if (!value) {
        result.unknown = "--tree-path (missing value)";
        return result;
      }
      result.treePath = value;
      index += 1;
      continue;
    }
    if (arg === "--source") {
      const value = args[index + 1];
      if (!value) {
        result.unknown = "--source (missing value)";
        return result;
      }
      result.source = value;
      index += 1;
      continue;
    }
    if (arg === "--propose") {
      result.propose = true;
      continue;
    }
    if (arg === "--apply") {
      result.apply = true;
      result.propose = true;
      continue;
    }
    if (arg === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    result.unknown = arg;
    return result;
  }
  return result;
}

async function getSourceHead(
  shellRun: ShellRun,
  ownerRepo: OwnerRepo,
): Promise<string | null> {
  const result = await shellRun("gh", [
    "api",
    `/repos/${ownerRepo.owner}/${ownerRepo.repo}/commits/HEAD`,
    "--jq",
    ".sha",
  ]);
  if (result.code !== 0) {
    console.error(
      `❌ gh api failed for ${ownerRepo.owner}/${ownerRepo.repo}: ${result.stderr.trim()}`,
    );
    return null;
  }
  const sha = result.stdout.trim();
  return sha === "" ? null : sha;
}

interface CompareCommit {
  sha: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
  };
  files?: Array<{ filename?: string }>;
}

function topDirOf(filename: string): string {
  const idx = filename.indexOf("/");
  return idx === -1 ? "(root)" : filename.slice(0, idx);
}

async function compareCommits(
  shellRun: ShellRun,
  ownerRepo: OwnerRepo,
  fromSha: string,
  toSha: string,
): Promise<{ commits: CommitSummary[]; truncated: boolean } | null> {
  const result = await shellRun("gh", [
    "api",
    `/repos/${ownerRepo.owner}/${ownerRepo.repo}/compare/${fromSha}...${toSha}`,
  ]);
  if (result.code !== 0) {
    console.error(
      `❌ gh api compare failed for ${ownerRepo.owner}/${ownerRepo.repo}: ${result.stderr.trim()}`,
    );
    return null;
  }
  let parsed: { commits?: CompareCommit[] };
  try {
    parsed = JSON.parse(result.stdout) as { commits?: CompareCommit[] };
  } catch {
    console.error(
      `❌ failed to parse gh compare JSON for ${ownerRepo.owner}/${ownerRepo.repo}`,
    );
    return null;
  }
  const raw = parsed.commits ?? [];
  const cap = 200;
  const truncated = raw.length > cap;
  const sliced = truncated ? raw.slice(0, cap) : raw;
  const summaries: CommitSummary[] = sliced.map((c) => {
    const message = c.commit?.message ?? "";
    const firstLine = message.split("\n")[0] ?? "";
    const files = c.files ?? [];
    const topDirs = new Set<string>();
    for (const file of files) {
      if (file.filename) topDirs.add(topDirOf(file.filename));
    }
    const topDir = topDirs.size === 0
      ? "(root)"
      : Array.from(topDirs).sort()[0];
    return {
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: firstLine,
      author: c.commit?.author?.name ?? "unknown",
      date: c.commit?.author?.date ?? "",
      topDir,
    };
  });
  return { commits: summaries, truncated };
}

async function fetchMergedPrTitles(
  shellRun: ShellRun,
  ownerRepo: OwnerRepo,
  sinceDate: string,
): Promise<string[]> {
  if (sinceDate === "") return [];
  const query = `repo:${ownerRepo.owner}/${ownerRepo.repo}+is:pr+is:merged+merged:>=${sinceDate.slice(0, 10)}`;
  const result = await shellRun("gh", [
    "api",
    `search/issues?q=${query}&per_page=50`,
  ]);
  if (result.code !== 0) {
    console.error(
      `⚠ gh api search/issues failed: ${result.stderr.trim()}`,
    );
    return [];
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      items?: Array<{ title?: string }>;
    };
    return (parsed.items ?? [])
      .map((item) => item.title ?? "")
      .filter((title) => title !== "");
  } catch {
    return [];
  }
}

async function classifyDriftViaClaude(
  shellRun: ShellRun,
  drift: DriftReport,
  treeNodes: TreeNodeSummary[],
): Promise<ClassificationItem[] | null> {
  const treeSummary = treeNodes
    .slice(0, 200)
    .map((n) => `- ${n.path} title=${n.title ?? ""} owners=${(n.owners ?? []).join("|")}`)
    .join("\n");
  const driftSummary = [
    ...drift.commits.map((c) => `commit ${c.shortSha} [${c.topDir}] ${c.message}`),
    ...drift.mergedPrTitles.map((title) => `pr ${title}`),
  ].join("\n");
  const prompt = `You are classifying source-repo changes against a Context Tree. Here is the tree structure (list of NODE.md paths + titles + owners):\n${treeSummary}\nHere are the source commits and merged PR titles:\n${driftSummary}\nFor each drift item, output JSON: {path, type: 'TREE_MISS'|'TREE_STALE'|'TREE_OK', target_node_path (or null for TREE_MISS), rationale (one sentence), suggested_node_title, suggested_node_body_markdown}. Return a JSON array only, no prose.`;
  const result = await shellRun("claude", [
    "-p",
    "--output-format",
    "json",
    prompt,
  ]);
  if (result.code !== 0) {
    return null;
  }
  const raw = result.stdout.trim();
  if (raw === "") return null;
  // Claude CLI with --output-format json may wrap the payload. Try direct parse first,
  // then look for a `result` / `content` field that contains a JSON array.
  const tryParseArray = (text: string): ClassificationItem[] | null => {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        return parsed as ClassificationItem[];
      }
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        for (const key of ["result", "content", "output", "response"]) {
          const value = obj[key];
          if (typeof value === "string") {
            const inner = tryParseArray(value);
            if (inner) return inner;
          }
          if (Array.isArray(value)) return value as ClassificationItem[];
        }
      }
    } catch {
      return null;
    }
    return null;
  };
  const direct = tryParseArray(raw);
  if (direct) return direct;
  // Last resort: extract first [...] block from the text
  const match = raw.match(/\[[\s\S]*\]/);
  if (match) {
    const extracted = tryParseArray(match[0]);
    if (extracted) return extracted;
  }
  return null;
}

function deterministicClassification(
  drift: DriftReport,
  treeNodes: TreeNodeSummary[],
): ClassificationItem[] {
  const existingDirs = new Set<string>();
  for (const node of treeNodes) {
    const segments = node.path.split("/");
    if (segments.length > 1) {
      existingDirs.add(segments[0]);
    }
  }
  const byDir = new Map<string, CommitSummary[]>();
  for (const commit of drift.commits) {
    const list = byDir.get(commit.topDir) ?? [];
    list.push(commit);
    byDir.set(commit.topDir, list);
  }
  const out: ClassificationItem[] = [];
  for (const [dir, commits] of Array.from(byDir.entries()).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    if (existingDirs.has(dir)) continue;
    const title = dir === "(root)" ? "Repository root" : `${dir} directory`;
    const body = [
      `# ${title}`,
      "",
      `Changes detected in \`${dir}\` that are not represented in the Context Tree yet.`,
      "",
      "## Recent commits",
      "",
      ...commits.map((c) => `- ${c.shortSha} — ${c.message}`),
      "",
    ].join("\n");
    out.push({
      path: dir,
      type: "TREE_MISS",
      target_node_path: null,
      rationale: `Source directory \`${dir}\` has ${commits.length} recent commit(s) but no matching tree node.`,
      suggested_node_title: title,
      suggested_node_body_markdown: body,
    });
  }
  return out;
}

function slugifyProposalPath(value: string): string {
  return slugifyToken(value.replace(/[\\/]/g, "-"));
}

function writeProposalFile(
  treeRoot: string,
  sourceId: string,
  drift: DriftReport,
  item: ClassificationItem,
): string {
  const slug = slugifyProposalPath(
    `${item.type === "TREE_MISS" ? "new" : "update"}-${item.target_node_path ?? item.path ?? item.suggested_node_title}`,
  );
  const dir = join(treeRoot, TREE_RUNTIME_ROOT, "proposals", sourceId);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${slug}.md`);
  const supersedes = item.type === "TREE_STALE" && item.target_node_path
    ? item.target_node_path
    : "null";
  const target = item.type === "TREE_MISS"
    ? "new"
    : item.target_node_path ?? "new";
  const frontmatter = [
    "---",
    `type: ${item.type}`,
    `source_id: ${sourceId}`,
    `source_commit_range: ${drift.fromSha ?? "(first-run)"}..${drift.toSha}`,
    `target_node: ${target}`,
    `supersedes: ${supersedes}`,
    `rationale: ${item.rationale.replace(/\n/g, " ")}`,
    "---",
    "",
  ].join("\n");
  writeFileSync(filePath, `${frontmatter}${item.suggested_node_body_markdown}\n`);
  return filePath;
}

function extractOwnersFromCodeowners(
  treeRoot: string,
  targetPath: string,
): string[] {
  const candidates = [
    join(treeRoot, "CODEOWNERS"),
    join(treeRoot, ".github", "CODEOWNERS"),
    join(treeRoot, "docs", "CODEOWNERS"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    let text;
    try {
      text = readFileSync(candidate, "utf-8");
    } catch {
      continue;
    }
    const matches: string[] = [];
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const pattern = parts[0];
      if (
        pattern === "*"
        || targetPath.startsWith(pattern.replace(/^\//, "").replace(/\/$/, ""))
      ) {
        matches.push(...parts.slice(1));
      }
    }
    if (matches.length > 0) return matches;
  }
  return [];
}

async function ghAuthOk(shellRun: ShellRun): Promise<boolean> {
  const result = await shellRun("gh", ["auth", "status"]);
  return result.code === 0;
}

function logDriftTable(reports: DriftReport[]): void {
  console.log("\nReconcile summary:");
  for (const report of reports) {
    const range = report.fromSha
      ? `${report.fromSha.slice(0, 7)}..${report.toSha.slice(0, 7)}`
      : `(first-run) -> ${report.toSha.slice(0, 7)}`;
    console.log(
      `  - ${report.binding.sourceId}: ${report.commits.length} commit(s) ${range}${
        report.truncated ? " [truncated]" : ""
      }`,
    );
  }
}

async function applyProposalsForBinding(
  shellRun: ShellRun,
  treeRoot: string,
  binding: TreeBindingState,
  drift: DriftReport,
  proposalPaths: string[],
  proposals: ClassificationItem[],
  dryRun: boolean,
  now: () => Date,
): Promise<boolean> {
  const shortSha = drift.toSha.slice(0, 7);
  const branch = `first-tree/reconcile-${binding.sourceId}-${shortSha}`;

  const branchCreate = await shellRun("git", ["checkout", "-b", branch], {
    cwd: treeRoot,
  });
  if (branchCreate.code !== 0) {
    // Maybe branch exists — try checking it out
    const fallback = await shellRun("git", ["checkout", branch], { cwd: treeRoot });
    if (fallback.code !== 0) {
      console.error(
        `❌ could not create branch ${branch}: ${branchCreate.stderr.trim()}`,
      );
      return false;
    }
  }

  for (let i = 0; i < proposals.length; i += 1) {
    const proposal = proposals[i];
    if (proposal.type === "TREE_OK") continue;
    if (proposal.type === "TREE_MISS") {
      const dirSegment = proposal.path === "(root)" ? "misc" : proposal.path;
      const relDir = join("drift", binding.sourceId, dirSegment);
      const absDir = join(treeRoot, relDir);
      mkdirSync(absDir, { recursive: true });
      const owners = extractOwnersFromCodeowners(treeRoot, relDir);
      const title = proposal.suggested_node_title;
      const body = proposal.suggested_node_body_markdown;
      const content = [
        "---",
        `title: "${title.replace(/"/g, '\\"')}"`,
        `owners: [${owners.join(", ")}]`,
        "---",
        "",
        body,
        "",
      ].join("\n");
      writeFileSync(join(absDir, "NODE.md"), content);
    } else if (proposal.type === "TREE_STALE" && proposal.target_node_path) {
      const target = proposal.target_node_path;
      const targetAbs = join(treeRoot, target);
      const supersededPath = join(
        dirname(targetAbs),
        `${basename(targetAbs, ".md")}.superseded-${shortSha}.md`,
      );
      mkdirSync(dirname(supersededPath), { recursive: true });
      const content = [
        "---",
        `supersedes: ${target}`,
        `source_commit: ${drift.toSha}`,
        "---",
        "",
        proposal.suggested_node_body_markdown,
        "",
      ].join("\n");
      writeFileSync(supersededPath, content);
    }
  }

  writeTreeBinding(treeRoot, binding.sourceId, {
    ...binding,
    lastReconciledSourceCommit: drift.toSha,
    lastReconciledAt: now().toISOString(),
  });

  const addResult = await shellRun("git", ["add", "-A"], { cwd: treeRoot });
  if (addResult.code !== 0) {
    console.error(`❌ git add failed: ${addResult.stderr.trim()}`);
    return false;
  }
  const commitMessage = `chore(reconcile): sync ${binding.sourceId} to ${shortSha}`;
  const commitResult = await shellRun("git", ["commit", "-m", commitMessage], {
    cwd: treeRoot,
  });
  if (commitResult.code !== 0) {
    console.error(`❌ git commit failed: ${commitResult.stderr.trim()}`);
    return false;
  }

  if (dryRun) {
    console.log(
      `(dry-run) would push ${branch} and open PR titled "${commitMessage}"`,
    );
    return true;
  }

  const pushResult = await shellRun("git", ["push", "origin", "HEAD"], {
    cwd: treeRoot,
  });
  if (pushResult.code !== 0) {
    console.error(`❌ git push failed: ${pushResult.stderr.trim()}`);
    return false;
  }

  const bodyLines = [
    `Automated drift reconciliation for source \`${binding.sourceId}\`.`,
    "",
    `- Source range: ${drift.fromSha ? drift.fromSha.slice(0, 7) : "first-run"}..${shortSha}`,
    `- Proposal files: ${proposalPaths.length}`,
    "",
    "Proposals:",
    ...proposals.map(
      (p) => `- ${p.type}: ${p.target_node_path ?? p.path} — ${p.rationale}`,
    ),
    "",
    "Commits:",
    ...drift.commits.map(
      (c) =>
        `- [\`${c.shortSha}\`](https://github.com/${drift.ownerRepo.owner}/${drift.ownerRepo.repo}/commit/${c.sha}) ${c.message}`,
    ),
  ];
  const prCreate = await shellRun(
    "gh",
    ["pr", "create", "--title", commitMessage, "--body", bodyLines.join("\n")],
    { cwd: treeRoot },
  );
  if (prCreate.code !== 0) {
    const stderr = prCreate.stderr.trim();
    if (
      stderr.toLowerCase().includes("already exists")
      || stderr.toLowerCase().includes("a pull request for branch")
    ) {
      console.log(
        `⏭ PR for branch ${branch} already exists — skipping create, leaving the existing one.`,
      );
      return true;
    }
    console.error(`❌ gh pr create failed: ${stderr}`);
    return false;
  }
  const prUrl = prCreate.stdout.trim();

  const labelResult = await shellRun(
    "gh",
    ["pr", "edit", prUrl, "--add-label", "first-tree:reconcile", "--add-label", "auto-merge"],
    { cwd: treeRoot },
  );
  if (labelResult.code !== 0) {
    console.error(`⚠ gh pr edit (add label) failed: ${labelResult.stderr.trim()}`);
  }
  console.log(`✓ opened PR ${prUrl}`);
  return true;
}

export async function runReconcile(
  treeRoot: string,
  flags: Omit<ParsedFlags, "help" | "unknown" | "treePath">,
  deps: ReconcileDeps = {},
): Promise<number> {
  const shellRun = deps.shellRun ?? defaultShellRun;
  const now = deps.now ?? (() => new Date());
  const repo = new Repo(treeRoot);

  if (!repo.looksLikeTreeRepo()) {
    console.error(
      `❌ ${treeRoot} does not look like a Context Tree repo. Run first-tree reconcile inside a tree repo, or pass --tree-path.`,
    );
    return 1;
  }

  const authed = await ghAuthOk(shellRun);
  if (!authed) {
    console.error("❌ gh CLI not authenticated — run `gh auth login`");
    return 1;
  }

  let bindings = listTreeBindings(repo.root);
  if (flags.source) {
    bindings = bindings.filter((b) => b.sourceId === flags.source);
    if (bindings.length === 0) {
      console.error(`❌ no binding matches --source ${flags.source}`);
      return 1;
    }
  }
  if (bindings.length === 0) {
    console.log("no bindings found under .first-tree/bindings/. nothing to reconcile.");
    return 0;
  }

  const treeNodes = scanTreeNodes(repo.root);
  const driftReports: DriftReport[] = [];

  for (const binding of bindings) {
    if (!binding.remoteUrl) {
      console.log(
        `⏭ ${binding.sourceId}: no remoteUrl recorded — skipping`,
      );
      continue;
    }
    const ownerRepo = parseOwnerRepoFromRemoteUrl(binding.remoteUrl);
    if (!ownerRepo) {
      console.log(
        `⏭ ${binding.sourceId}: could not parse GitHub owner/repo from ${binding.remoteUrl} — skipping`,
      );
      continue;
    }
    const head = await getSourceHead(shellRun, ownerRepo);
    if (!head) {
      console.error(`❌ failed to fetch HEAD for ${binding.sourceId}`);
      return 1;
    }
    if (!binding.lastReconciledSourceCommit) {
      writeTreeBinding(repo.root, binding.sourceId, {
        ...binding,
        lastReconciledSourceCommit: head,
        lastReconciledAt: now().toISOString(),
      });
      console.log(
        `✓ pinned ${binding.sourceId} to ${head.slice(0, 7)} (first run, no proposals)`,
      );
      continue;
    }
    if (binding.lastReconciledSourceCommit === head) {
      console.log(`✓ ${binding.sourceId}: up to date at ${head.slice(0, 7)}`);
      continue;
    }
    const compared = await compareCommits(
      shellRun,
      ownerRepo,
      binding.lastReconciledSourceCommit,
      head,
    );
    if (!compared) {
      return 1;
    }
    const sinceDate =
      compared.commits.length > 0 ? compared.commits[0].date : "";
    const mergedPrTitles = await fetchMergedPrTitles(
      shellRun,
      ownerRepo,
      sinceDate,
    );
    if (compared.truncated) {
      console.log(
        `⚠ ${binding.sourceId}: commit range truncated to 200 commits`,
      );
    }
    driftReports.push({
      binding,
      ownerRepo,
      fromSha: binding.lastReconciledSourceCommit,
      toSha: head,
      commits: compared.commits,
      mergedPrTitles,
      truncated: compared.truncated,
    });
  }

  logDriftTable(driftReports);

  if (!flags.propose && !flags.apply) {
    return 0;
  }

  if (driftReports.length === 0) {
    console.log("nothing stale to propose.");
    return 0;
  }

  for (const drift of driftReports) {
    let proposals = await classifyDriftViaClaude(shellRun, drift, treeNodes);
    if (!proposals) {
      console.log(
        `⚠ ${drift.binding.sourceId}: LLM classification unavailable — falling back to deterministic grouping`,
      );
      proposals = deterministicClassification(drift, treeNodes);
    }
    const filtered = proposals.filter((p) => p.type !== "TREE_OK");
    const written: string[] = [];
    for (const item of filtered) {
      const path = writeProposalFile(repo.root, drift.binding.sourceId, drift, item);
      written.push(path);
    }
    console.log(
      `✓ ${drift.binding.sourceId}: wrote ${written.length} proposal(s) under .first-tree/proposals/${drift.binding.sourceId}/`,
    );

    if (flags.apply) {
      const ok = await applyProposalsForBinding(
        shellRun,
        repo.root,
        drift.binding,
        drift,
        written,
        filtered,
        flags.dryRun,
        now,
      );
      if (!ok) return 1;
    }
  }

  return 0;
}

export async function runReconcileCli(
  args: string[] = [],
  deps: ReconcileDeps = {},
): Promise<number> {
  const flags = parseFlags(args);
  if (flags.help) {
    console.log(RECONCILE_USAGE);
    return 0;
  }
  if (flags.unknown) {
    console.error(`Unknown reconcile option: ${flags.unknown}`);
    console.log(RECONCILE_USAGE);
    return 1;
  }
  const treeRoot = flags.treePath
    ? resolve(process.cwd(), flags.treePath)
    : process.cwd();
  try {
    return await runReconcile(
      treeRoot,
      {
        source: flags.source,
        propose: flags.propose,
        apply: flags.apply,
        dryRun: flags.dryRun,
      },
      deps,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`❌ reconcile failed: ${message}`);
    return 1;
  }
}
