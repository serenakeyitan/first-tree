import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { writeSourceState, writeTreeState } from "../src/commands/tree/binding-state.js";
import { initializeSourceRoot } from "../src/commands/tree/init.js";
import { publishTreeRoot } from "../src/commands/tree/publish.js";

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

describe("publishTreeRoot", () => {
  it("publishes using an existing tree remote and refreshes a source root", () => {
    const treeRoot = makeTempDir("first-tree-publish-tree-");
    const sourceRoot = makeTempDir("first-tree-publish-source-");
    writeFileSync(join(treeRoot, ".git"), "gitdir: /tmp/tree\n");
    writeFileSync(join(sourceRoot, ".git"), "gitdir: /tmp/source\n");

    writeTreeState(treeRoot, {
      published: {
        remoteUrl: "https://github.com/acme/context-tree.git",
      },
      treeId: "context-tree",
      treeMode: "shared",
      treeRepoName: "context-tree",
    });
    writeSourceState(sourceRoot, {
      bindingMode: "shared-source",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "product-repo",
      sourceName: "product-repo",
      tree: {
        entrypoint: "/repos/product-repo",
        treeId: "context-tree",
        treeMode: "shared",
        treeRepoName: "context-tree",
      },
    });

    const commandRunner = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
        return "https://github.com/acme/context-tree.git";
      }
      if (command === "gh" && args[0] === "repo" && args[1] === "view") {
        return "";
      }
      if (command === "git" && args[0] === "push") {
        return "";
      }
      if (command === "git" && args[0] === "remote" && args[1] === "set-url") {
        return "";
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    const summary = publishTreeRoot(treeRoot, {
      commandRunner,
      sourceRepoPath: sourceRoot,
    });

    expect(summary.publishedTreeUrl).toBe("https://github.com/acme/context-tree.git");
    expect(summary.refreshedSourceRoots).toEqual([sourceRoot]);
    expect(commandRunner).toHaveBeenCalledWith(
      "gh",
      ["repo", "view", "acme/context-tree"],
      treeRoot,
    );
    expect(commandRunner).toHaveBeenCalledWith(
      "git",
      ["push", "-u", "origin", "HEAD:main"],
      treeRoot,
    );
  });
});

describe("initializeSourceRoot", () => {
  it("creates a sibling dedicated tree and binds the source repo", () => {
    const sourceRoot = makeTempDir("first-tree-init-source-");
    writeFileSync(join(sourceRoot, ".git"), "gitdir: /tmp/source\n");
    const previousCwd = process.cwd();
    process.chdir(sourceRoot);

    try {
      const summary = initializeSourceRoot(sourceRoot, "unbound-source-repo");

      expect(summary.bindingMode).toBe("standalone-source");
      expect(summary.treeRoot).toBe(
        resolve(dirname(sourceRoot), `${sourceRoot.split("/").pop()}-tree`),
      );
      expect(
        readFileSync(
          join(summary.treeRoot, ".first-tree", "agent-templates", "developer.yaml"),
          "utf8",
        ),
      ).toContain("name: developer");
      expect(
        readFileSync(
          join(summary.treeRoot, ".first-tree", "agent-templates", "code-reviewer.yaml"),
          "utf8",
        ),
      ).toContain("name: code-reviewer");
      expect(readFileSync(join(summary.treeRoot, ".first-tree", "org.yaml"), "utf8")).toContain(
        "humanInvolveRules:",
      );
    } finally {
      process.chdir(previousCwd);
    }
  });
});
