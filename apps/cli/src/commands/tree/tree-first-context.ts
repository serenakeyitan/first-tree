import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { TREE_SOURCE_REPOS_FILE, listTreeBindings, readTreeState } from "./binding-state.js";
import { readSourceBindingContract } from "./binding-contract.js";
import { buildSourceRepoIndexTable } from "./source-repo-index.js";

const ROOT_NODE_FILE = "NODE.md";

type ResolvedTreeContextRoot = {
  currentEntrypoint?: string;
  entrypointLabel: string;
  treeRoot: string;
};

export type TreeFirstContextBundle = {
  additionalContext: string;
  treeRoot: string;
};

export function buildTreeFirstContextBundle(currentRoot: string): TreeFirstContextBundle | null {
  const resolved = resolveTreeContextRoot(currentRoot);

  if (resolved === null) {
    return readFallbackLocalNode(currentRoot);
  }

  const nodePath = join(resolved.treeRoot, ROOT_NODE_FILE);
  if (!existsSync(nodePath)) {
    return null;
  }

  const rootNode = readFileSync(nodePath, "utf-8").trimEnd();
  const bindings = listTreeBindings(resolved.treeRoot);
  const sections = [rootNode];
  const repoContext = buildRepoContextSection(
    bindings,
    resolved.currentEntrypoint,
    resolved.entrypointLabel,
  );

  if (repoContext !== null) {
    sections.push(repoContext);
  }

  return {
    additionalContext: `${sections.join("\n\n---\n\n")}\n`,
    treeRoot: resolved.treeRoot,
  };
}

function resolveTreeContextRoot(currentRoot: string): ResolvedTreeContextRoot | null {
  if (readTreeState(currentRoot) !== null) {
    return {
      entrypointLabel: "tree repo root",
      treeRoot: currentRoot,
    };
  }

  const sourceBinding = readSourceBindingContract(currentRoot);
  if (sourceBinding === undefined || sourceBinding.treeRepoName === undefined) {
    return null;
  }

  const siblingRoot = join(dirname(currentRoot), sourceBinding.treeRepoName);
  if (readTreeState(siblingRoot) !== null) {
    return {
      currentEntrypoint: sourceBinding.entrypoint,
      entrypointLabel: "bound source/workspace root",
      treeRoot: siblingRoot,
    };
  }

  const tempRoot = join(currentRoot, ".first-tree", "tmp", sourceBinding.treeRepoName);
  if (readTreeState(tempRoot) !== null) {
    return {
      currentEntrypoint: sourceBinding.entrypoint,
      entrypointLabel: "bound source/workspace root",
      treeRoot: tempRoot,
    };
  }

  return null;
}

function readFallbackLocalNode(currentRoot: string): TreeFirstContextBundle | null {
  const nodePath = join(currentRoot, ROOT_NODE_FILE);
  if (!existsSync(nodePath)) {
    return null;
  }

  return {
    additionalContext: readFileSync(nodePath, "utf-8"),
    treeRoot: currentRoot,
  };
}

function buildRepoContextSection(
  bindings: ReturnType<typeof listTreeBindings>,
  currentEntrypoint: string | undefined,
  entrypointLabel: string,
): string | null {
  if (bindings.length === 0 && currentEntrypoint === undefined) {
    return null;
  }

  const lines = [
    "## Tree-First Cross-Repo Working Context",
    "",
    "- Repo index source: `.first-tree/bindings/*.json`",
    `- Human-readable index: \`${TREE_SOURCE_REPOS_FILE}\` when present`,
    `- Current entrypoint: \`${currentEntrypoint ?? entrypointLabel}\``,
    "",
    "## Bound Source/Workspace Repos",
    "",
    ...buildSourceRepoIndexTable(bindings),
  ];

  return lines.join("\n");
}
