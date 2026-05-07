import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { writeTreeState } from "../src/commands/tree/binding-state.js";
import { buildSourceIntegrationBlock } from "../src/commands/tree/source-integration.js";
import { runTreeReview } from "../src/commands/tree/review-helper.js";
import { upgradeTargetRoot } from "../src/commands/tree/upgrade.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("upgradeTargetRoot", () => {
  it("upgrades a bound source root", () => {
    const sourceRoot = makeTempDir("first-tree-upgrade-source-");
    writeFileSync(
      join(sourceRoot, "AGENTS.md"),
      `${buildSourceIntegrationBlock("context-tree", {
        bindingMode: "shared-source",
        entrypoint: "/repos/product-repo",
        treeMode: "shared",
        treeRepoName: "context-tree",
      })}\n`,
    );

    const summary = upgradeTargetRoot(sourceRoot);

    expect(summary.targetKind).toBe("source");
  });

  it("upgrades a tree root", () => {
    const treeRoot = makeTempDir("first-tree-upgrade-tree-");
    writeTreeState(treeRoot, {
      treeId: "context-tree",
      treeMode: "shared",
      treeRepoName: "context-tree",
    });

    const summary = upgradeTargetRoot(treeRoot);

    expect(summary.targetKind).toBe("tree");
  });
});

describe("runTreeReview", () => {
  it("writes parsed review JSON to the requested output path", () => {
    const root = makeTempDir("first-tree-review-root-");
    const diffPath = join(root, "pr.diff");
    const outputPath = join(root, "review.json");
    writeFileSync(join(root, "AGENTS.md"), "# Agents\n");
    writeFileSync(join(root, "NODE.md"), "# Root\n");
    writeFileSync(diffPath, "diff --git a/foo.md b/foo.md\n");

    const exitCode = runTreeReview({
      diffPath,
      outputPath,
      repoRoot: root,
      runner: () => '{"verdict":"APPROVE","summary":"Looks good"}',
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(outputPath, "utf-8")).toContain('"verdict": "APPROVE"');
  });
});
