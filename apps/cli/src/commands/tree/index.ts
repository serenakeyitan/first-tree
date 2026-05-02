import type { Command } from "commander";

import { createPlaceholderSubcommand } from "../placeholder.js";
import type { CommandModule, SubcommandModule } from "../types.js";
import { registerCommandGroup, registerSubcommands } from "../groups.js";
import { generateCodeownersCommand } from "./generate-codeowners.js";
import { inspectCommand } from "./inspect.js";
import { installClaudeCodeHookCommand } from "./install-claude-code-hook.js";
import { skillSubcommands } from "./skill.js";
import { statusCommand } from "./status.js";

type CommandWithUnknownCommand = Command & {
  unknownCommand(): void;
};

const TREE_ONBOARDING_GUIDE = `first-tree tree help onboarding

1. Run \`first-tree tree inspect --json\` to classify the current folder.
2. Decide whether you need a new dedicated tree repo or an existing shared tree.
3. Use \`first-tree tree init\` for the high-level onboarding flow.
4. If this root is a workspace, follow with \`first-tree tree workspace sync\`.
5. Before starting \`first-tree github scan\`, make sure a binding exists in
   \`.first-tree/source.json\` or pass \`--tree-repo <owner/repo>\`.

This restructured workspace is still being ported back from the old main branch.
Some tree subcommands are scaffolding today, but this is the intended public
command surface for the 0.4.0 CLI layout.
`;

const treeSubcommands: SubcommandModule[] = [
  inspectCommand,
  statusCommand,
  createPlaceholderSubcommand({
    name: "init",
    description: "Onboard a repo or workspace to a Context Tree.",
    message: "first-tree tree init is not implemented yet.",
  }),
  createPlaceholderSubcommand({
    name: "bootstrap",
    description: "Bootstrap an explicit tree repo checkout.",
    message: "first-tree tree bootstrap is not implemented yet.",
  }),
  createPlaceholderSubcommand({
    name: "bind",
    description: "Bind the current repo or workspace to an existing tree repo.",
    message: "first-tree tree bind is not implemented yet.",
  }),
  createPlaceholderSubcommand({
    name: "integrate",
    description: "Install local tree integration without mutating the tree repo.",
    message: "first-tree tree integrate is not implemented yet.",
  }),
  createPlaceholderSubcommand({
    name: "verify",
    description: "Validate a Context Tree repo.",
    message: "first-tree tree verify is not implemented yet.",
  }),
  createPlaceholderSubcommand({
    name: "upgrade",
    description: "Refresh local first-tree integration and tree metadata.",
    message: "first-tree tree upgrade is not implemented yet.",
  }),
  createPlaceholderSubcommand({
    name: "publish",
    description: "Publish a tree repo and refresh bound source repos.",
    message: "first-tree tree publish is not implemented yet.",
  }),
  generateCodeownersCommand,
  installClaudeCodeHookCommand,
  createPlaceholderSubcommand({
    name: "inject-context",
    description: "Emit the Claude Code SessionStart payload from NODE.md.",
    message: "first-tree tree inject-context is not implemented yet.",
  }),
  createPlaceholderSubcommand({
    name: "review",
    description: "Run the tree PR review helper.",
    message: "first-tree tree review is not implemented yet.",
  }),
];

export const treeCommand: CommandModule = {
  name: "tree",
  description: "Work with Context Tree commands.",
  register(program: Command): void {
    const command = program
      .command("tree")
      .description("Work with Context Tree commands.")
      .helpCommand(false)
      .allowExcessArguments(true)
      .action(() => {
        if (command.args.length > 0) {
          (command as CommandWithUnknownCommand).unknownCommand();
          return;
        }

        command.outputHelp();
      });

    registerSubcommands(command, treeSubcommands);

    registerCommandGroup(command, "workspace", "Run workspace tree helpers.", [
      createPlaceholderSubcommand({
        name: "sync",
        description: "Bind newly added child repos to the shared tree.",
        message: "first-tree tree workspace sync is not implemented yet.",
      }),
    ]);

    registerCommandGroup(
      command,
      "skill",
      "Install and repair first-tree skill payloads.",
      skillSubcommands,
    );

    registerCommandGroup(command, "help", "Show Context Tree help topics.", [
      {
        name: "onboarding",
        alias: "",
        summary: "",
        description: "Show the onboarding guide.",
        action: () => {
          console.log(TREE_ONBOARDING_GUIDE.trimEnd());
        },
      },
    ]);
  },
};
