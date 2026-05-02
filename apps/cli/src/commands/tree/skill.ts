import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Command } from "commander";

import type { CommandContext, SubcommandModule } from "../types.js";

const SKILL_NAMES = [
  "first-tree",
  "first-tree-onboarding",
  "first-tree-sync",
  "first-tree-write",
  "first-tree-github-scan",
] as const;

type SkillName = (typeof SKILL_NAMES)[number];

type SkillLayout = {
  name: SkillName;
  agentsPath: string;
  claudePath: string;
  claudeSymlinkTarget: string;
};

type SkillStatus = {
  name: SkillName;
  installed: boolean;
  version: string | null;
  agentsKind: "missing" | "symlink" | "directory";
  agentsTarget: string | null;
  claudeKind: "missing" | "symlink" | "directory";
  claudeTarget: string | null;
};

type SkillDiagnosis = {
  name: SkillName;
  ok: boolean;
  problems: string[];
};

const ROOT_OPTION_DESCRIPTION = "operate on a different root (default: cwd)";
const FIRST_TREE_REFERENCE_FILES = [
  "SKILL.md",
  "VERSION",
  join("agents", "openai.yaml"),
  join("references", "structure.md"),
  join("references", "functions.md"),
  join("references", "anti-patterns.md"),
  join("references", "maintenance.md"),
  join("references", "cli-manual.md"),
  join("references", "llms.txt"),
] as const;
const STANDARD_SKILL_REQUIRED_FILES = [
  "SKILL.md",
  "VERSION",
  join("agents", "openai.yaml"),
] as const;

function configureRootOption(command: Command): void {
  command.option("--root <path>", ROOT_OPTION_DESCRIPTION);
}

function layoutForSkill(name: SkillName): SkillLayout {
  return {
    name,
    agentsPath: join(".agents", "skills", name),
    claudePath: join(".claude", "skills", name),
    claudeSymlinkTarget: join("..", "..", ".agents", "skills", name),
  };
}

function allSkillLayouts(): readonly SkillLayout[] {
  return SKILL_NAMES.map(layoutForSkill);
}

function requiredFilesForSkill(name: SkillName): readonly string[] {
  return name === "first-tree" ? FIRST_TREE_REFERENCE_FILES : STANDARD_SKILL_REQUIRED_FILES;
}

function bundledSkillsRootFrom(startDir: string): string {
  let currentDir = resolve(startDir);

  while (true) {
    const candidate = join(currentDir, "skills", "first-tree", "SKILL.md");

    if (existsSync(candidate)) {
      return join(currentDir, "skills");
    }

    const parentDir = dirname(currentDir);

    if (parentDir === currentDir) {
      throw new Error(
        "Could not locate bundled `skills/` payloads. Run from a source checkout or a packaged dist that includes `skills/`.",
      );
    }

    currentDir = parentDir;
  }
}

function resolveBundledSkillsRoot(): string {
  return bundledSkillsRootFrom(dirname(fileURLToPath(import.meta.url)));
}

function readTargetRoot(command: Command): string {
  const options = command.opts() as { root?: string };
  return resolve(options.root ?? process.cwd());
}

function inspectEntry(path: string): {
  kind: "missing" | "symlink" | "directory";
  target: string | null;
} {
  try {
    const stat = lstatSync(path);

    if (stat.isSymbolicLink()) {
      return {
        kind: "symlink",
        target: readlinkSync(path),
      };
    }

    if (stat.isDirectory()) {
      return {
        kind: "directory",
        target: null,
      };
    }
  } catch {
    // Fall through to missing.
  }

  return {
    kind: "missing",
    target: null,
  };
}

function readVersion(path: string): string | null {
  const versionPath = join(path, "VERSION");

  if (!existsSync(versionPath)) {
    return null;
  }

  try {
    return readFileSync(versionPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function ensureClaudeSymlink(targetRoot: string, layout: SkillLayout): void {
  const claudeFull = join(targetRoot, layout.claudePath);
  mkdirSync(dirname(claudeFull), { recursive: true });

  const existing = inspectEntry(claudeFull);
  if (existing.kind !== "missing") {
    if (existing.kind === "symlink" && existing.target === layout.claudeSymlinkTarget) {
      return;
    }

    rmSync(claudeFull, { force: true, recursive: true });
  }

  symlinkSync(layout.claudeSymlinkTarget, claudeFull);
}

function copyCanonicalSkills(targetRoot: string): void {
  const bundledSkillsRoot = resolveBundledSkillsRoot();

  for (const layout of allSkillLayouts()) {
    const sourceDir = join(bundledSkillsRoot, layout.name);
    const agentsFull = join(targetRoot, layout.agentsPath);
    mkdirSync(dirname(agentsFull), { recursive: true });
    rmSync(agentsFull, { force: true, recursive: true });
    cpSync(sourceDir, agentsFull, { recursive: true });
    ensureClaudeSymlink(targetRoot, layout);
  }
}

function collectSkillStatus(targetRoot: string): readonly SkillStatus[] {
  return allSkillLayouts().map((layout) => {
    const agentsFull = join(targetRoot, layout.agentsPath);
    const claudeFull = join(targetRoot, layout.claudePath);
    const agents = inspectEntry(agentsFull);
    const claude = inspectEntry(claudeFull);
    const installed = agents.kind !== "missing" && claude.kind !== "missing";

    return {
      name: layout.name,
      installed,
      version: agents.kind === "missing" ? null : readVersion(agentsFull),
      agentsKind: agents.kind,
      agentsTarget: agents.target,
      claudeKind: claude.kind,
      claudeTarget: claude.target,
    };
  });
}

function collectSkillDiagnosis(targetRoot: string): readonly SkillDiagnosis[] {
  return allSkillLayouts().map((layout) => {
    const problems: string[] = [];
    const agentsFull = join(targetRoot, layout.agentsPath);
    const claudeFull = join(targetRoot, layout.claudePath);
    const agents = inspectEntry(agentsFull);
    const claude = inspectEntry(claudeFull);

    if (agents.kind === "missing") {
      problems.push(`missing: ${layout.agentsPath}`);
    } else {
      for (const requiredFile of requiredFilesForSkill(layout.name)) {
        if (!existsSync(join(agentsFull, requiredFile))) {
          problems.push(`${layout.agentsPath}/${requiredFile} does not exist`);
        }
      }
    }

    if (claude.kind === "missing") {
      problems.push(`missing: ${layout.claudePath}`);
    } else if (claude.kind !== "symlink") {
      problems.push(`${layout.claudePath} should be a symlink to ${layout.claudeSymlinkTarget}`);
    } else if (claude.target !== layout.claudeSymlinkTarget) {
      problems.push(
        `${layout.claudePath} -> ${claude.target}, expected ${layout.claudeSymlinkTarget}`,
      );
    }

    return {
      name: layout.name,
      ok: problems.length === 0,
      problems,
    };
  });
}

function runInstallSkillCommand(context: CommandContext): void {
  const targetRoot = readTargetRoot(context.command);
  copyCanonicalSkills(targetRoot);
  console.log(`Installed ${SKILL_NAMES.length} shipped first-tree skills into ${targetRoot}.`);
}

function runUpgradeSkillCommand(context: CommandContext): void {
  const targetRoot = readTargetRoot(context.command);
  copyCanonicalSkills(targetRoot);
  console.log(`Upgraded ${SKILL_NAMES.length} shipped first-tree skills in ${targetRoot}.`);
}

function runListSkillCommand(context: CommandContext): void {
  const targetRoot = readTargetRoot(context.command);
  const rows = collectSkillStatus(targetRoot);

  if (context.options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const nameWidth = Math.max(...rows.map((row) => row.name.length));
  console.log(`${"NAME".padEnd(nameWidth)}  STATUS     VERSION`);
  console.log("-".repeat(nameWidth + 18));
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(nameWidth)}  ${(row.installed ? "installed" : "missing").padEnd(9)}  ${row.version ?? "-"}`,
    );
  }
}

function runDoctorSkillCommand(context: CommandContext): void {
  const targetRoot = readTargetRoot(context.command);
  const rows = collectSkillDiagnosis(targetRoot);

  if (context.options.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log("=== first-tree tree skill doctor ===");
    console.log("");
    for (const row of rows) {
      if (row.ok) {
        console.log(`  OK ${row.name}`);
        continue;
      }

      console.log(`  FAIL ${row.name}`);
      for (const problem of row.problems) {
        console.log(`    - ${problem}`);
      }
    }
  }

  const failingRows = rows.filter((row) => !row.ok);
  if (failingRows.length > 0) {
    if (!context.options.json) {
      console.log("");
      console.log(`Found problems in ${failingRows.length} of ${rows.length} skills.`);
      console.log("Fix with:");
      console.log("  first-tree tree skill link");
      console.log("  first-tree tree skill upgrade");
    }
    process.exitCode = 1;
  }
}

function runLinkSkillCommand(context: CommandContext): void {
  const targetRoot = readTargetRoot(context.command);
  let linked = 0;
  let skipped = 0;

  for (const layout of allSkillLayouts()) {
    const agentsFull = join(targetRoot, layout.agentsPath);

    if (!existsSync(agentsFull)) {
      skipped += 1;
      continue;
    }

    const claudeFull = join(targetRoot, layout.claudePath);
    const before = inspectEntry(claudeFull);
    ensureClaudeSymlink(targetRoot, layout);
    const after = inspectEntry(claudeFull);

    if (before.kind !== "symlink" || before.target !== after.target) {
      linked += 1;
      console.log(`linked ${layout.claudePath} -> ${layout.claudeSymlinkTarget}`);
    }
  }

  console.log("");
  console.log(
    `Linked ${linked} symlink(s); skipped ${skipped} skill(s) without an .agents install.`,
  );
}

export const skillSubcommands: SubcommandModule[] = [
  {
    name: "install",
    alias: "",
    summary: "",
    description: "Install shipped first-tree skills into local agent directories.",
    action: runInstallSkillCommand,
    configure: configureRootOption,
  },
  {
    name: "upgrade",
    alias: "",
    summary: "",
    description: "Reinstall shipped first-tree skills from the current package.",
    action: runUpgradeSkillCommand,
    configure: configureRootOption,
  },
  {
    name: "list",
    alias: "",
    summary: "",
    description: "List the installed first-tree skill payloads and versions.",
    action: runListSkillCommand,
    configure: configureRootOption,
  },
  {
    name: "doctor",
    alias: "",
    summary: "",
    description: "Diagnose first-tree skill installation health.",
    action: runDoctorSkillCommand,
    configure: configureRootOption,
  },
  {
    name: "link",
    alias: "",
    summary: "",
    description: "Repair .claude skill aliases that point to .agents skills.",
    action: runLinkSkillCommand,
    configure: configureRootOption,
  },
];
