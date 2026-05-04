import { dirname, join, resolve } from "node:path";

import type { Command } from "commander";

import type { CommandContext, SubcommandModule } from "../types.js";
import { bindSourceRoot } from "./bind.js";
import { bootstrapTreeRoot } from "./bootstrap.js";
import { inspectCurrentWorkingTree } from "./inspect.js";
import { repoNameForRoot } from "./shared.js";
import { readTreeIdentityContract } from "./tree-identity.js";
import { syncWorkspaceMembersFromRoot } from "./workspace-sync.js";

type InitOptions = {
  scope?: "repo" | "workspace";
  treeMode?: "dedicated" | "shared";
  treeName?: string;
  treePath?: string;
  treeUrl?: string;
  workspaceId?: string;
};

type InitSummary = {
  bindingMode: string;
  sourceRoot: string;
  treeRoot: string;
  treeMode: "dedicated" | "shared";
  workspaceId?: string;
};

export const INIT_USAGE = `usage: first-tree tree init [--tree-path PATH | --tree-url URL] [--tree-name NAME] [--tree-mode dedicated|shared] [--scope repo|workspace] [--workspace-id ID]

Onboard a repo or workspace to a Context Tree.

Options:
  --tree-path PATH    use an explicit local tree repo path
  --tree-url URL      bind to an existing remote tree repo
  --tree-name NAME    override the default sibling tree repo name
  --tree-mode MODE    dedicated or shared
  --scope MODE        repo or workspace
  --workspace-id ID   workspace identifier for shared workspace onboarding
  --help              show this help message`;

function configureInitCommand(command: Command): void {
  command
    .option("--tree-path <path>", "use an explicit local tree repo path")
    .option("--tree-url <url>", "bind to an existing remote tree repo")
    .option("--tree-name <name>", "override the default sibling tree repo name")
    .option("--tree-mode <mode>", "dedicated or shared")
    .option("--scope <scope>", "repo or workspace")
    .option("--workspace-id <id>", "workspace identifier for shared workspace onboarding");
}

function readInitOptions(command: Command): InitOptions {
  const options = command.opts() as Record<string, string | undefined>;
  return {
    scope: options.scope as "repo" | "workspace" | undefined,
    treeMode: options.treeMode as "dedicated" | "shared" | undefined,
    treeName: options.treeName,
    treePath: options.treePath,
    treeUrl: options.treeUrl,
    workspaceId: options.workspaceId,
  };
}

function resolveScope(options: InitOptions, role: string): "repo" | "workspace" {
  if (options.scope !== undefined) {
    return options.scope;
  }

  return role.includes("workspace") ? "workspace" : "repo";
}

function resolveTreeMode(
  options: InitOptions,
  scope: "repo" | "workspace",
): "dedicated" | "shared" {
  if (options.treeMode !== undefined) {
    return options.treeMode;
  }

  return scope === "workspace" ? "shared" : "dedicated";
}

function resolveTreeRoot(
  sourceRoot: string,
  options: InitOptions,
  _treeMode: "dedicated" | "shared",
): string | undefined {
  if (options.treePath) {
    return resolve(process.cwd(), options.treePath);
  }

  if (options.treeUrl) {
    return undefined;
  }

  const defaultName = options.treeName ?? `${repoNameForRoot(sourceRoot)}-tree`;
  return join(dirname(sourceRoot), defaultName);
}

export function initializeSourceRoot(
  sourceRoot: string,
  role: string,
  options: InitOptions = {},
): InitSummary {
  const scope = resolveScope(options, role);
  const treeMode = resolveTreeMode(options, scope);
  const treeRoot = resolveTreeRoot(sourceRoot, options, treeMode);

  if (treeRoot !== undefined && readTreeIdentityContract(treeRoot) === undefined) {
    bootstrapTreeRoot(treeRoot, {
      treeMode,
    });
  }

  const bindingSummary = bindSourceRoot(
    sourceRoot,
    {
      mode: scope === "workspace" ? "workspace-root" : "source",
      treeMode,
      ...(treeRoot ? { treePath: treeRoot } : {}),
      ...(options.treeUrl ? { treeUrl: options.treeUrl } : {}),
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    },
    process.cwd(),
  );

  if (scope === "workspace" && treeRoot) {
    if (
      syncWorkspaceMembersFromRoot({
        treePath: treeRoot,
        workspaceId: options.workspaceId,
        workspaceRoot: sourceRoot,
      })
    ) {
      process.exitCode = 1;
    }
  }

  return {
    bindingMode: bindingSummary.bindingMode,
    sourceRoot,
    treeRoot: treeRoot ?? bindingSummary.treeRoot,
    treeMode,
    ...(bindingSummary.workspaceId ? { workspaceId: bindingSummary.workspaceId } : {}),
  };
}

function runInitCommand(context: CommandContext): void {
  try {
    const inspection = inspectCurrentWorkingTree();
    const options = readInitOptions(context.command);
    const summary = initializeSourceRoot(inspection.rootPath, inspection.role, options);

    if (context.options.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log("Context Tree Init\n");
    console.log(`  Source/workspace root: ${summary.sourceRoot}`);
    console.log(`  Tree root:             ${summary.treeRoot}`);
    console.log(`  Binding mode:          ${summary.bindingMode}`);
    console.log(`  Tree mode:             ${summary.treeMode}`);
    if (summary.workspaceId) {
      console.log(`  Workspace id:          ${summary.workspaceId}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export const initCommand: SubcommandModule = {
  name: "init",
  alias: "",
  summary: "",
  description: "Onboard a repo or workspace to a Context Tree.",
  action: runInitCommand,
  configure: configureInitCommand,
};
