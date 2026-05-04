import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { Command } from "commander";

import type { CommandContext, SubcommandModule } from "../types.js";
import {
  BoundTreeReference,
  RootKind,
  removeSourceState,
  SourceBindingMode,
  TreeMode,
  buildStableSourceId,
  buildTreeId,
  deriveDefaultEntrypoint,
  determineScope,
  readTreeState,
  writeTreeBinding,
  writeTreeState,
} from "./binding-state.js";
import { copyCanonicalSkills } from "./skill-lib.js";
import { syncTreeSourceRepoIndex } from "./source-repo-index.js";
import {
  ensureWhitepaperSymlink,
  upsertLocalTreeGitIgnore,
  upsertSourceIntegrationFiles,
} from "./source-integration.js";
import {
  isGitRepoRoot,
  parseGitHubRemoteUrl,
  readGitRemoteUrl,
  repoNameForRoot,
  resolveRepoRoot,
  runCommand,
} from "./shared.js";

type BindModeOption = SourceBindingMode | "source";

type BindOptions = {
  entrypoint?: string;
  mode?: BindModeOption;
  treeMode?: TreeMode;
  treePath?: string;
  treeUrl?: string;
  workspaceId?: string;
  workspaceRoot?: string;
};

type BindSummary = {
  bindingMode: SourceBindingMode;
  rootKind: RootKind;
  sourceRoot: string;
  treeBindingPath: string;
  treeMode: TreeMode;
  treeRoot: string;
  treeStatePath: string;
  workspaceId?: string;
};

type BindingContext = {
  bindingMode: SourceBindingMode;
  entrypoint: string;
  rootKind: RootKind;
  sourceId: string;
  sourceRemoteUrl?: string;
  sourceRepoName: string;
  treeMode: TreeMode;
  treeReference: BoundTreeReference;
  workspaceId?: string;
};

export const BIND_USAGE = `usage: first-tree tree bind [--tree-path PATH | --tree-url URL] [--tree-mode dedicated|shared] [--mode source|standalone-source|shared-source|workspace-root|workspace-member] [--workspace-id ID] [--workspace-root PATH] [--entrypoint PATH]

Bind the current source/workspace root to an existing Context Tree repo.

Options:
  --tree-path PATH      Local checkout of the tree repo to bind
  --tree-url URL        Remote URL for the tree repo; if --tree-path is omitted, clone it to a sibling checkout
  --tree-mode MODE      dedicated or shared (default: infer)
  --mode MODE           source, standalone-source, shared-source, workspace-root, or workspace-member
  --workspace-id ID     Workspace identifier for workspace-root/member bindings
  --workspace-root PATH Workspace root path when binding a workspace member repo
  --entrypoint PATH     Override the default tree entrypoint for this binding
  --help                Show this help message`;

function configureBindCommand(command: Command): void {
  command
    .option("--tree-path <path>", "local checkout of the tree repo")
    .option("--tree-url <url>", "remote URL of the tree repo")
    .option("--tree-mode <mode>", "dedicated or shared")
    .option(
      "--mode <mode>",
      "source, standalone-source, shared-source, workspace-root, or workspace-member",
    )
    .option("--workspace-id <id>", "workspace identifier")
    .option("--workspace-root <path>", "workspace root path for workspace-member binds")
    .option("--entrypoint <path>", "tree entrypoint override");
}

function readBindOptions(command: Command): BindOptions {
  const options = command.opts() as Record<string, string | undefined>;
  return {
    entrypoint: options.entrypoint,
    mode: options.mode as BindModeOption | undefined,
    treeMode: options.treeMode as TreeMode | undefined,
    treePath: options.treePath,
    treeUrl: options.treeUrl,
    workspaceId: options.workspaceId,
    workspaceRoot: options.workspaceRoot,
  };
}

function inferTreeRepoNameFromUrl(treeUrl: string): string {
  const parsed = parseGitHubRemoteUrl(treeUrl);
  if (parsed !== null) {
    return parsed.repo;
  }

  return basename(treeUrl).replace(/\.git$/u, "");
}

function inferTreeMode(
  sourceRepoName: string,
  treeRepoName: string,
  explicit?: TreeMode,
): TreeMode {
  if (explicit !== undefined) {
    if (explicit !== "dedicated" && explicit !== "shared") {
      throw new Error(`Unsupported value for --tree-mode: ${explicit}`);
    }
    return explicit;
  }

  const defaultDedicatedNames = new Set([`${sourceRepoName}-tree`, `${sourceRepoName}-context`]);

  return defaultDedicatedNames.has(treeRepoName) ? "dedicated" : "shared";
}

function resolveBindingMode(
  explicit: BindModeOption | undefined,
  treeMode: TreeMode,
): SourceBindingMode {
  if (explicit === "source") {
    return treeMode === "shared" ? "shared-source" : "standalone-source";
  }

  if (explicit !== undefined) {
    if (
      explicit !== "standalone-source" &&
      explicit !== "shared-source" &&
      explicit !== "workspace-root" &&
      explicit !== "workspace-member"
    ) {
      throw new Error(`Unsupported value for --mode: ${explicit}`);
    }
    return explicit;
  }

  return treeMode === "shared" ? "shared-source" : "standalone-source";
}

function resolveWorkspaceId(
  sourceRoot: string,
  bindingMode: SourceBindingMode,
  explicit?: string,
): string | undefined {
  if (bindingMode !== "workspace-root" && bindingMode !== "workspace-member") {
    return undefined;
  }

  return explicit?.trim() || repoNameForRoot(sourceRoot);
}

function ensureTreeCheckout(
  cwd: string,
  sourceRoot: string,
  options: BindOptions,
): { treeRepoName: string; treeRoot: string; treeUrl?: string } {
  let treeRoot = options.treePath ? resolve(cwd, options.treePath) : undefined;
  let treeUrl = options.treeUrl?.trim() || undefined;

  if (treeRoot === undefined && treeUrl === undefined) {
    throw new Error("Missing --tree-path or --tree-url.");
  }

  if (treeRoot === undefined && treeUrl !== undefined) {
    const inferredName = inferTreeRepoNameFromUrl(treeUrl);
    treeRoot = join(dirname(sourceRoot), inferredName);

    if (!existsSync(treeRoot)) {
      runCommand("git", ["clone", treeUrl, treeRoot], dirname(treeRoot));
    }
  }

  if (treeRoot === undefined) {
    throw new Error("Could not resolve the tree checkout.");
  }

  if (!isGitRepoRoot(treeRoot)) {
    throw new Error(
      `Tree checkout is not a git repository: ${treeRoot}. Point bind at an existing tree checkout first.`,
    );
  }

  if (resolve(treeRoot) === resolve(sourceRoot)) {
    throw new Error(
      "The source/workspace root and tree repo resolved to the same path. Use `first-tree tree bootstrap --here` when the current repo itself should become the tree.",
    );
  }

  treeUrl = treeUrl ?? readGitRemoteUrl(treeRoot) ?? readTreeState(treeRoot)?.published?.remoteUrl;

  return {
    treeRepoName: repoNameForRoot(treeRoot),
    treeRoot,
    ...(treeUrl ? { treeUrl } : {}),
  };
}

export function bindSourceRoot(
  sourceRoot: string,
  options: BindOptions,
  commandCwd = process.cwd(),
): BindSummary {
  const treeResolution = ensureTreeCheckout(commandCwd, sourceRoot, options);
  const binding = deriveBindingContext(sourceRoot, treeResolution, options);

  copyCanonicalSkills(sourceRoot);
  copyCanonicalSkills(treeResolution.treeRoot);
  ensureWhitepaperSymlink(sourceRoot);
  upsertLocalTreeGitIgnore(sourceRoot);
  upsertSourceIntegrationFiles(sourceRoot, treeResolution.treeRepoName, {
    bindingMode: binding.bindingMode,
    entrypoint: binding.entrypoint,
    treeMode: binding.treeMode,
    treeRepoUrl: treeResolution.treeUrl,
    workspaceId: binding.workspaceId,
  });
  removeSourceState(sourceRoot);

  writeBoundTreeState(
    treeResolution.treeRoot,
    treeResolution.treeRepoName,
    binding.treeMode,
    binding.treeReference.treeId,
    treeResolution.treeUrl,
  );

  writeTreeBinding(treeResolution.treeRoot, binding.sourceId, {
    bindingMode: binding.bindingMode,
    entrypoint: binding.entrypoint,
    ...(binding.sourceRemoteUrl ? { remoteUrl: binding.sourceRemoteUrl } : {}),
    rootKind: binding.rootKind,
    scope: determineScope(binding.bindingMode),
    sourceId: binding.sourceId,
    sourceName: binding.sourceRepoName,
    treeMode: binding.treeMode,
    treeRepoName: treeResolution.treeRepoName,
    ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}),
  });

  syncTreeSourceRepoIndex(treeResolution.treeRoot);

  return {
    bindingMode: binding.bindingMode,
    rootKind: binding.rootKind,
    sourceRoot,
    treeBindingPath: join(
      treeResolution.treeRoot,
      ".first-tree",
      "bindings",
      `${binding.sourceId}.json`,
    ),
    treeMode: binding.treeMode,
    treeRoot: treeResolution.treeRoot,
    treeStatePath: join(treeResolution.treeRoot, ".first-tree", "tree.json"),
    ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}),
  };
}

function deriveBindingContext(
  sourceRoot: string,
  treeResolution: { treeRepoName: string; treeRoot: string; treeUrl?: string },
  options: BindOptions,
): BindingContext {
  const sourceRepoName = repoNameForRoot(sourceRoot);
  const treeMode = inferTreeMode(sourceRepoName, treeResolution.treeRepoName, options.treeMode);
  const bindingMode = resolveBindingMode(options.mode, treeMode);
  const workspaceId = resolveWorkspaceId(sourceRoot, bindingMode, options.workspaceId);
  const sourceRemoteUrl = isGitRepoRoot(sourceRoot) ? readGitRemoteUrl(sourceRoot) : undefined;
  const sourceId = buildStableSourceId(sourceRepoName, {
    fallbackRoot: sourceRoot,
    remoteUrl: sourceRemoteUrl,
  });
  const entrypoint =
    options.entrypoint ?? deriveDefaultEntrypoint(bindingMode, sourceRepoName, workspaceId);

  return {
    bindingMode,
    entrypoint,
    rootKind: isGitRepoRoot(sourceRoot) ? "git-repo" : "folder",
    sourceId,
    ...(sourceRemoteUrl ? { sourceRemoteUrl } : {}),
    sourceRepoName,
    treeMode,
    treeReference: {
      entrypoint,
      ...(treeResolution.treeUrl ? { remoteUrl: treeResolution.treeUrl } : {}),
      treeId: buildTreeId(treeResolution.treeRepoName),
      treeMode,
      treeRepoName: treeResolution.treeRepoName,
    },
    ...(workspaceId ? { workspaceId } : {}),
  };
}

function writeBoundTreeState(
  treeRoot: string,
  treeRepoName: string,
  treeMode: TreeMode,
  treeId: string,
  resolvedTreeUrl?: string,
): void {
  const existingTreeState = readTreeState(treeRoot);
  const publishedRemote = resolvedTreeUrl ?? existingTreeState?.published?.remoteUrl;

  writeTreeState(treeRoot, {
    ...(publishedRemote ? { published: { remoteUrl: publishedRemote } } : {}),
    treeId,
    treeMode,
    treeRepoName,
  });
}

function runBindCommand(context: CommandContext): void {
  try {
    const summary = bindSourceRoot(
      resolveRepoRoot(process.cwd()),
      readBindOptions(context.command),
    );

    if (context.options.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log("Context Tree Bind\n");
    console.log(`  Source/workspace root: ${summary.sourceRoot}`);
    console.log(`  Tree repo:             ${summary.treeRoot}`);
    console.log(`  Binding mode:          ${summary.bindingMode}`);
    console.log(`  Tree mode:             ${summary.treeMode}`);
    if (summary.workspaceId) {
      console.log(`  Workspace id:          ${summary.workspaceId}`);
    }
    console.log("");
    console.log("  Updated AGENTS.md / CLAUDE.md managed binding blocks.");
    console.log(`  Wrote ${summary.treeStatePath}.`);
    console.log(`  Wrote ${summary.treeBindingPath}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export const bindCommand: SubcommandModule = {
  name: "bind",
  alias: "",
  summary: "",
  description: "Bind the current repo or workspace to an existing tree repo.",
  action: runBindCommand,
  configure: configureBindCommand,
};
