/**
 * `first-tree github scan install` — first-run setup for the github-scan daemon.
 *
 * Creates `~/.first-tree/github-scan/config.yaml` with defaults (if absent) and hands
 * off daemon startup to `first-tree github scan start`.
 *
 * This package is invoked through the umbrella CLI. It only prepares the local
 * daemon runtime.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import {
  parseAllowRepoArg,
  requireExplicitRepoFilter,
  REQUIRED_ALLOW_REPO_USAGE,
} from "../runtime/allow-repo.js";

const DEFAULT_CONFIG = `# github-scan configuration
poll_interval_sec: 60
task_timeout_sec: 1800
log_level: info
http_port: 7878
host: github.com
`;

export interface InstallDeps {
  githubScanDir?: string;
  write?: (text: string) => void;
  spawn?: typeof spawnSync;
  checkCommand?: (cmd: string) => boolean;
  checkGhAuth?: () => boolean;
  startCommand?: {
    cmd: string;
    args: string[];
  };
  /**
   * Resolves the repo root so we can find apps/tray-mac/scripts/install-tray.sh.
   * Production callers leave this default; tests inject a fixture path.
   */
  repoRoot?: string;
  /**
   * Override "is this an interactive TTY?". Tests pass false to suppress prompts.
   */
  isInteractive?: () => boolean;
  /**
   * Read a single line of user input. Defaults to readline on stdin.
   */
  prompt?: (question: string) => Promise<string>;
}

/** macOS-only menu bar tray onboarding choices, parsed from CLI flags. */
interface TrayChoice {
  /** "yes" — install tray. "no" — skip. "ask" — prompt the user (default). */
  install: "yes" | "no" | "ask";
  /** Whether to remove macOS quarantine on the installed app. */
  keepQuarantine: boolean;
}

function parseTrayFlags(args: readonly string[]): TrayChoice {
  let install: TrayChoice["install"] = "ask";
  let keepQuarantine = false;
  for (const arg of args) {
    if (arg === "--tray" || arg === "--tray=yes") install = "yes";
    else if (arg === "--no-tray" || arg === "--tray=no") install = "no";
    else if (arg === "--keep-quarantine" || arg === "--keep-quarantine=yes") keepQuarantine = true;
    else if (arg === "--keep-quarantine=no") keepQuarantine = false;
  }
  return { install, keepQuarantine };
}

export function resolveSelfStartCommand(
  entrypoint: string | undefined = process.argv[1],
): { cmd: string; args: string[] } {
  if (entrypoint && entrypoint.length > 0) {
    return {
      cmd: process.execPath,
      args: [entrypoint, "github", "scan", "start"],
    };
  }
  return { cmd: "first-tree", args: ["github", "scan", "start"] };
}

function defaultCheckCommand(cmd: string): boolean {
  const result = spawnSync("command", ["-v", cmd], {
    shell: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

function defaultCheckGhAuth(): boolean {
  const result = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
  return result.status === 0;
}

export async function runInstall(
  args: readonly string[],
  deps: InstallDeps = {},
): Promise<number> {
  if (args.length > 0 && (args[0] === "--help" || args[0] === "-h")) {
    (deps.write ?? console.log)(`usage: first-tree github scan install

  Bootstraps the local github-scan daemon:

    1. Checks for gh and gh auth status
    2. Creates \`~/.first-tree/github-scan/config.yaml\` with defaults (if absent)
    3. Starts the daemon via \`first-tree github scan start\`
    4. (macOS only) Optionally installs the menu bar app

  Required:
    ${REQUIRED_ALLOW_REPO_USAGE}   Explicit repo scope for the daemon startup

  Menu bar app (macOS only):
    --tray                     Install the menu bar app without prompting
    --no-tray                  Skip the menu bar app without prompting
    --keep-quarantine          Don't remove macOS quarantine on the installed
                               app (you'll see a one-time confirmation dialog
                               on first launch). Default: silent first launch.

  Environment:
    GITHUB_SCAN_DIR            Override \`~/.first-tree/github-scan\` (store root)
`);
    return 0;
  }

  const write = deps.write ?? ((text: string) => process.stdout.write(text + "\n"));
  const checkCommand = deps.checkCommand ?? defaultCheckCommand;
  const checkGhAuth = deps.checkGhAuth ?? defaultCheckGhAuth;
  const spawn = deps.spawn ?? spawnSync;
  const githubScanDir =
    deps.githubScanDir ?? process.env.GITHUB_SCAN_DIR ?? join(homedir(), ".first-tree/github-scan");
  const startCommand = deps.startCommand ?? resolveSelfStartCommand();
  try {
    requireExplicitRepoFilter(parseAllowRepoArg(args));
  } catch (err) {
    write(
      `ERROR: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  write("=== github-scan setup ===");
  write("");
  write("Checking prerequisites...");

  if (!checkCommand("gh")) {
    write("ERROR: gh CLI is not installed. Install it: https://cli.github.com/");
    return 1;
  }
  if (!checkGhAuth()) {
    write("ERROR: gh is not authenticated. Run `gh auth login` first.");
    return 1;
  }
  write("  gh CLI: OK");
  write("  gh auth: OK");
  write("");

  write(`Setting up ${githubScanDir}...`);
  mkdirSync(githubScanDir, { recursive: true });
  const configPath = join(githubScanDir, "config.yaml");
  if (existsSync(configPath)) {
    write(`  Config already exists at ${configPath}`);
    // Surface the relevant fields so users know what they're inheriting.
    summarizeExistingConfig(configPath, write);
  } else {
    writeFileSync(configPath, DEFAULT_CONFIG);
    write(`  Created default config at ${configPath}`);
  }
  write("");

  const isRunning = stopExistingDaemonIfRunning(githubScanDir, startCommand, spawn, write);
  startDaemon(args, startCommand, spawn, write, isRunning);

  // macOS-only: offer to install the menu bar tray app, which mirrors the dashboard.
  if (platform() === "darwin") {
    await installTrayInteractive(args, deps, write, spawn);
  }

  write("=== github-scan setup complete ===");
  write("");
  write("  Dashboard:  http://127.0.0.1:7878");
  write("  Status:     first-tree github scan status");
  write("  Stop:       first-tree github scan stop");
  write("  Inspect:    first-tree github scan doctor");

  return 0;
}

/**
 * Self-healing: if a daemon is already running for this dir, stop it so `start`
 * can re-bootstrap with the user's new args. Returns whether a daemon was running.
 */
function stopExistingDaemonIfRunning(
  githubScanDir: string,
  startCommand: { cmd: string; args: string[] },
  spawn: typeof spawnSync,
  write: (text: string) => void,
): boolean {
  const isRunning = checkDaemonRunning(githubScanDir);
  if (!isRunning) {
    write("Starting the github-scan daemon...");
    return false;
  }
  write("Detected a running daemon — restarting it with the new configuration...");
  const stopResult = spawn(startCommand.cmd, [...startCommand.args.slice(0, -1), "stop"], {
    stdio: "ignore",
  });
  if (stopResult.status !== 0) {
    write("  WARN: existing daemon failed to stop cleanly; continuing anyway");
  }
  return true;
}

function startDaemon(
  args: readonly string[],
  startCommand: { cmd: string; args: string[] },
  spawn: typeof spawnSync,
  write: (text: string) => void,
  wasRunning: boolean,
): void {
  // Strip tray-only flags before forwarding to `start` (which doesn't know them).
  const startArgs = args.filter(
    (a) =>
      a !== "--tray" &&
      a !== "--no-tray" &&
      a !== "--tray=yes" &&
      a !== "--tray=no" &&
      a !== "--keep-quarantine",
  );
  const result = spawn(startCommand.cmd, [...startCommand.args, ...startArgs], {
    stdio: "inherit",
  });
  if (result.status === 0) {
    write(wasRunning ? "  Daemon restarted" : "  Daemon started");
  } else {
    write(
      "  WARN: daemon start failed; rerun `first-tree github scan start --allow-repo owner/repo` manually",
    );
  }
  write("");
}

/**
 * Walks the user through installing the menu bar tray. Honors --tray / --no-tray
 * / --keep-quarantine flags. In a TTY, prompts when no flag was given. In a
 * non-TTY (CI, scripts), defaults to skipping (we don't silently install GUI
 * apps for unattended runs).
 */
async function installTrayInteractive(
  args: readonly string[],
  deps: InstallDeps,
  write: (text: string) => void,
  spawn: typeof spawnSync,
): Promise<void> {
  const choice = parseTrayFlags(args);
  const repoRoot = deps.repoRoot ?? findRepoRoot();
  const installScript = repoRoot
    ? join(repoRoot, "apps/tray-mac/scripts/install-tray.sh")
    : null;

  // If we can't find the install script, the tray isn't shipped with this
  // build — skip silently. (E.g., the daemon was installed standalone without
  // the apps/tray-mac/ directory alongside it.)
  if (!installScript || !existsSync(installScript)) {
    return;
  }

  const isInteractive = deps.isInteractive ?? (() => Boolean(process.stdin.isTTY));

  // Resolve the user's choice: explicit flag wins; otherwise prompt if interactive.
  let installDecision: boolean;
  let keepQuarantine = choice.keepQuarantine;
  if (choice.install === "yes") {
    installDecision = true;
  } else if (choice.install === "no") {
    installDecision = false;
  } else if (isInteractive()) {
    write("Menu bar app (macOS):");
    write(
      "  Adds a small icon to your menu bar so you can see and act on GitHub items",
    );
    write("  without opening a browser. Same data as the dashboard.");
    write("");
    const ans = (await (deps.prompt ?? defaultPrompt)("Install it? [Y/n] ")).trim().toLowerCase();
    installDecision = ans !== "n" && ans !== "no";

    if (installDecision && !choice.keepQuarantine) {
      // Soft-explain quarantine in plain language. Default is "yes, open instantly".
      write("");
      write(
        "First time you open it, macOS may ask you to confirm. Want to skip that and",
      );
      write("open it instantly? Recommended unless you specifically want the warning.");
      const q = (await (deps.prompt ?? defaultPrompt)("Open instantly? [Y/n] ")).trim().toLowerCase();
      keepQuarantine = q === "n" || q === "no";
    }
  } else {
    // Non-interactive and no flag given — skip; user can re-run with --tray.
    return;
  }

  if (!installDecision) {
    write("  Skipped menu bar app. Run `first-tree github scan install --tray` later to add it.");
    write("");
    return;
  }

  write("");
  write("Installing menu bar app...");
  const scriptArgs: string[] = [];
  if (keepQuarantine) scriptArgs.push("--keep-quarantine");
  const r = spawn(installScript, scriptArgs, { stdio: "inherit" });
  if (r.status === 0) {
    write("  Menu bar icon should now be visible in the top-right of your screen.");
  } else {
    write(
      "  WARN: tray install failed. You can retry with `first-tree github scan install --tray`",
    );
  }
  write("");
}

/**
 * Walk up from this module looking for the apps/tray-mac/ directory marker.
 * Returns the repo root or null. Lets `install` find the install-tray.sh
 * script regardless of where in the build tree this code is loaded from.
 */
function findRepoRoot(): string | null {
  let current: string;
  try {
    current = dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(current, "apps/tray-mac/scripts/install-tray.sh"))) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Print the user-visible fields of an existing config.yaml so they know what
 * they're inheriting on a re-install. Skips fields that match defaults.
 */
function summarizeExistingConfig(configPath: string, write: (text: string) => void): void {
  let raw: string;
  try {
    raw = require("node:fs").readFileSync(configPath, "utf8");
  } catch {
    return;
  }
  const lines = raw.split("\n");
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const m = /^([a-z_][a-z0-9_]*):\s*(.+?)\s*(#.*)?$/i.exec(line.trim());
    if (m) fields[m[1]] = m[2];
  }
  const summary: string[] = [];
  if (fields.http_port) summary.push(`http_port: ${fields.http_port}`);
  if (fields.poll_interval_sec) summary.push(`poll_interval_sec: ${fields.poll_interval_sec}`);
  if (fields.host) summary.push(`host: ${fields.host}`);
  if (summary.length > 0) {
    write(`    (${summary.join(", ")})`);
  }
}

/**
 * Detect whether a daemon is currently running for the given GITHUB_SCAN_DIR.
 * Reads the lock file the daemon writes when alive (under
 * `runner/locks/<host>__<login>__<profile>/lock.env`) and checks that the pid
 * actually exists. Returns false if the lock is stale (process gone) or
 * missing entirely.
 */
function checkDaemonRunning(githubScanDir: string): boolean {
  const fs = require("node:fs") as typeof import("node:fs");
  let lockDirs: string[];
  try {
    lockDirs = fs.readdirSync(join(githubScanDir, "runner/locks"));
  } catch {
    return false;
  }
  for (const dir of lockDirs) {
    let body: string;
    try {
      body = fs.readFileSync(join(githubScanDir, "runner/locks", dir, "lock.env"), "utf8");
    } catch {
      continue;
    }
    const pidMatch = /^pid=(\d+)/m.exec(body);
    if (!pidMatch) continue;
    const pid = Number.parseInt(pidMatch[1], 10);
    try {
      // Signal 0 throws if the process is gone.
      process.kill(pid, 0);
      return true;
    } catch {
      // stale lock; check the next one
    }
  }
  return false;
}

function defaultPrompt(question: string): Promise<string> {
  return new Promise((resolveAns) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolveAns(answer);
    });
  });
}
