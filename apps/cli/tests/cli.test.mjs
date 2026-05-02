import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(testDir, "..");
const repoRoot = resolve(cliRoot, "../..");
const entryPath = resolve(cliRoot, "dist/index.js");
const rootPackagePath = resolve(repoRoot, "package.json");
const cliPackagePath = resolve(cliRoot, "package.json");
const commandNames = ["tree", "github", "hub"];
const rootHelpCommandPaths = [
  "first-tree tree inspect",
  "first-tree tree skill install",
  "first-tree github scan",
  "first-tree hub start",
];
const commandGroups = [
  {
    name: "tree",
    subcommands: ["inspect", "status", "init", "workspace", "skill", "help"],
  },
  {
    name: "github",
    subcommands: ["scan"],
  },
  {
    name: "hub",
    subcommands: ["start", "stop", "doctor", "status"],
  },
];

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function makeGitRepoDir(prefix) {
  const dir = await mkdtemp(resolve(tmpdir(), prefix));
  await writeFile(resolve(dir, ".git"), "gitdir: /tmp/mock\n");
  return dir;
}

function runCli(args, options = {}) {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [entryPath, ...args],
      { cwd: options.cwd ?? repoRoot },
      (error, stdout, stderr) => {
        resolveRun({
          code: error && "code" in error ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

describe("first-tree CLI", () => {
  it("prints the workspace package version", async () => {
    const rootPackage = await readJson(rootPackagePath);
    const cliPackage = await readJson(cliPackagePath);
    const result = await runCli(["--version"]);

    expect(cliPackage.version).toBe(rootPackage.version);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(rootPackage.version);
  });

  it("prints help with registered commands", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: first-tree");
    expect(result.stdout).toContain("CLI for Context Tree, GitHub Scan, and Hub workflows.");
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("-d, --debug");
    expect(result.stdout).toContain("-q, --quiet");
    for (const commandName of commandNames) {
      expect(result.stdout).toContain(commandName);
    }
    expect(result.stdout).toContain("All commands:");
    for (const commandPath of rootHelpCommandPaths) {
      expect(result.stdout).toContain(commandPath);
    }
  });

  it("prints inspect output for the current repo", async () => {
    const cwd = await makeGitRepoDir("first-tree-inspect-");
    const result = await runCli(["tree", "inspect"], { cwd });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("first-tree tree inspect");
    expect(result.stdout).toContain("classification: git-repo");
  });

  it("prints inspect json for the current repo", async () => {
    const cwd = await makeGitRepoDir("first-tree-inspect-json-");
    const result = await runCli(["tree", "inspect", "--json"], { cwd });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"classification": "git-repo"');
  });

  it("prints onboarding help from the tree help namespace", async () => {
    const result = await runCli(["tree", "help", "onboarding"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("first-tree tree help onboarding");
    expect(result.stdout).toContain("github scan");
  });

  it("runs tree placeholder commands successfully", async () => {
    const initResult = await runCli(["tree", "init"]);
    const workspaceResult = await runCli(["tree", "workspace", "sync"]);

    expect(initResult.code).toBe(0);
    expect(initResult.stdout.trim()).toBe("first-tree tree init is not implemented yet.");
    expect(workspaceResult.code).toBe(0);
    expect(workspaceResult.stdout.trim()).toBe(
      "first-tree tree workspace sync is not implemented yet.",
    );
  });

  it("installs and inspects shipped skills through `tree skill` commands", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "first-tree-skill-install-"));

    const installResult = await runCli(["tree", "skill", "install", "--root", root]);
    const listResult = await runCli(["tree", "skill", "list", "--root", root]);
    const doctorResult = await runCli(["tree", "skill", "doctor", "--root", root]);
    const linkResult = await runCli(["tree", "skill", "link", "--root", root]);

    expect(installResult.code).toBe(0);
    expect(installResult.stdout).toContain("Installed 5 shipped first-tree skills");

    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toContain("first-tree-onboarding");
    expect(listResult.stdout).toContain("installed");

    expect(doctorResult.code).toBe(0);
    expect(doctorResult.stdout).toContain("OK first-tree");
    expect(doctorResult.stdout).toContain("OK first-tree-github-scan");

    expect(linkResult.code).toBe(0);
    expect(linkResult.stdout).toContain("Linked");
  });

  it("runs bare `github scan` and prints help with exit 0", async () => {
    const result = await runCli(["github", "scan"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: first-tree github scan");
    expect(result.stdout).toContain("GitHub Scan is the GitHub notification daemon");
  });

  it("passes github scan args through without commander interception", async () => {
    const result = await runCli(["github", "scan", "status", "--allow-repo", "foo"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("first-tree github scan");
    expect(result.stderr).toContain("invalid repo allow pattern");
  });

  it("fails closed when github scan poll has no tree binding", async () => {
    const cwd = await makeGitRepoDir("first-tree-no-binding-");
    const result = await runCli(["github", "scan", "poll", "--allow-repo", "owner/repo"], { cwd });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("requires a bound tree repo");
    expect(result.stderr).toContain("first-tree tree bind");
  });

  it("forwards --help to github scan", async () => {
    const result = await runCli(["github", "scan", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: first-tree github scan");
  });

  for (const commandGroup of commandGroups) {
    it(`prints ${commandGroup.name} help with registered subcommands`, async () => {
      const result = await runCli([commandGroup.name, "--help"]);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`Usage: first-tree ${commandGroup.name}`);
      expect(result.stdout).not.toContain("All commands:");
      for (const subcommandName of commandGroup.subcommands) {
        expect(result.stdout).toContain(subcommandName);
      }
    });

    it(`prints ${commandGroup.name} help when no subcommand is provided`, async () => {
      const result = await runCli([commandGroup.name]);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`Usage: first-tree ${commandGroup.name}`);
      expect(result.stdout).not.toContain("All commands:");
      for (const subcommandName of commandGroup.subcommands) {
        expect(result.stdout).toContain(subcommandName);
      }
    });
  }

  it("prints nested tree group help", async () => {
    const skillHelp = await runCli(["tree", "skill"]);
    const workspaceHelp = await runCli(["tree", "workspace"]);

    expect(skillHelp.code).toBe(0);
    expect(skillHelp.stdout).toContain("Usage: first-tree tree skill");
    expect(skillHelp.stdout).toContain("install");

    expect(workspaceHelp.code).toBe(0);
    expect(workspaceHelp.stdout).toContain("Usage: first-tree tree workspace");
    expect(workspaceHelp.stdout).toContain("sync");
  });

  it("runs hub placeholder commands successfully", async () => {
    const result = await runCli(["hub", "start"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("first-tree hub start is not implemented yet.");
  });

  it("prints subcommand help after an invalid option", async () => {
    const result = await runCli(["tree", "generate-codeowners", "--bad-option"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: unknown option '--bad-option'");
    expect(result.stderr).toContain("Usage: first-tree tree generate-codeowners");
    expect(result.stderr).toContain("Options:");
  });

  it("suggests a third-level subcommand for an unknown typo", async () => {
    const result = await runCli(["tree", "inspec"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: unknown command 'inspec'");
    expect(result.stderr).toContain("(Did you mean inspect?)");
  });

  it("keeps a shebang on the compiled entry", async () => {
    const entrySource = await readFile(entryPath, "utf8");

    expect(entrySource.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("runs through a bin-style symlink", async () => {
    const rootPackage = await readJson(rootPackagePath);
    const tempDir = await mkdtemp(resolve(tmpdir(), "first-tree-bin-"));
    const binPath = resolve(tempDir, "first-tree");

    try {
      await symlink(entryPath, binPath);

      const result = await new Promise((resolveRun) => {
        execFile(
          process.execPath,
          [binPath, "--version"],
          { cwd: repoRoot },
          (error, stdout, stderr) => {
            resolveRun({
              code: error && "code" in error ? error.code : 0,
              stdout,
              stderr,
            });
          },
        );
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe(rootPackage.version);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("exposes first-tree and ft bins through the compiled entry", async () => {
    const cliPackage = await readJson(cliPackagePath);

    expect(cliPackage.bin).toEqual({
      "first-tree": "./dist/index.js",
      ft: "./dist/index.js",
    });
  });
});
