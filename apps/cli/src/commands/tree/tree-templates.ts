export function renderRootNode(treeTitle: string): string {
  return [
    "---",
    `title: "${treeTitle}"`,
    "owners: []",
    "---",
    "",
    `# ${treeTitle}`,
    "",
    "The living source of truth for your organization. A structured knowledge base that agents and humans build and maintain together across one or more source repositories and systems.",
    "",
    "---",
    "",
    "## Domains",
    "",
    "- **[members/](members/NODE.md)** — Team member definitions and responsibilities.",
    "",
    "---",
    "",
    "## Working with the Tree",
    "",
    "Keep decision context here. Keep implementation detail in the source repos this tree describes.",
    "",
    "See [AGENTS.md](AGENTS.md) for agent instructions — the before/during/after workflow, ownership model, and tree maintenance.",
    "",
  ].join("\n");
}

export function renderMembersDomainNode(): string {
  return [
    "---",
    'title: "Members"',
    "owners: []",
    "---",
    "",
    "# Members",
    "",
    "Member definitions, work scope, and personal node specifications.",
    "",
  ].join("\n");
}

export function renderDefaultMemberNode(memberTitle = "Owner"): string {
  return [
    "---",
    `title: "${memberTitle}"`,
    "owners: []",
    "type: human",
    "role: owner",
    "domains: [core]",
    "---",
    "",
    `# ${memberTitle}`,
    "",
    "Default bootstrap member node. Update this once the real member roster is known.",
    "",
  ].join("\n");
}

export function renderDeveloperAgentTemplate(): string {
  return [
    "name: developer",
    "prompt: |",
    "  Default First Tree developer agent.",
    "  Use First Tree context before changing cross-repo decisions or ownership.",
    "skills:",
    "  - .agents/skills/first-tree",
    "  - .agents/skills/first-tree-sync",
    "  - .agents/skills/first-tree-write",
    "  - .agents/skills/first-tree-github-scan",
    "runtime: codex",
    "workspace:",
    "  kind: worktree",
    "env: {}",
    "auth:",
    "  github:",
    "    provider: env",
    "    variable: GITHUB_TOKEN",
    "mcp: []",
    "",
  ].join("\n");
}

export function renderCodeReviewerAgentTemplate(): string {
  return [
    "name: code-reviewer",
    "prompt: |",
    "  Default First Tree code review agent.",
    "  Focus on review quality, tree implications, and when human escalation is required.",
    "skills:",
    "  - .agents/skills/first-tree",
    "  - .agents/skills/first-tree-sync",
    "  - .agents/skills/first-tree-write",
    "  - .agents/skills/first-tree-github-scan",
    "runtime: codex",
    "workspace:",
    "  kind: worktree",
    "env: {}",
    "auth:",
    "  github:",
    "    provider: env",
    "    variable: GITHUB_TOKEN",
    "mcp: []",
    "",
  ].join("\n");
}

export function renderOrgConfigPlaceholder(): string {
  return [
    "agents: []",
    "collaboration:",
    "  routing: []",
    "  review: []",
    "humanInvolveRules:",
    "  defaults:",
    "    - missing-owner",
    "    - cross-domain-impact",
    "    - unknown-decision",
    "companyContext:",
    '  industry: ""',
    '  stage: ""',
    "  techStackConstraints: []",
    "  culture: []",
    "",
  ].join("\n");
}

export function renderTreeAgentsInstructions(): string {
  return [
    "<!-- BEGIN CONTEXT-TREE FRAMEWORK — do not edit this section -->",
    "# Agent Instructions for Context Tree",
    "",
    "You are working in a **Context Tree** — the living source of truth for decisions across the organization. Read and follow this before doing anything.",
    "",
    "## Principles",
    "",
    "1. **Source of truth for decisions, not execution.** The tree captures the *what* and *why* — strategic choices, cross-domain relationships, constraints. Execution details stay in source systems.",
    "2. **Agents are first-class participants.** The tree is designed to be navigated and updated by agents, not just humans.",
    "3. **Transparency by default.** All information is readable by everyone. Writing requires owner approval; reading is open.",
    "4. **Git-native tree structure.** Each node is a file; each domain is a directory.",
    "",
    "## Before Every Task",
    "",
    "1. Read the root NODE.md to understand the domain map.",
    "2. Read the NODE.md of every domain relevant to your task.",
    "3. Follow soft_links and read the linked nodes too.",
    "4. Read relevant leaf nodes before making cross-domain decisions.",
    "",
    "## During the Task",
    "",
    "- Decide in the tree, execute in source systems.",
    "- Keep execution detail in code repos and runtime systems.",
    "- Respect ownership fields in node frontmatter.",
    "",
    "## After Every Task",
    "",
    "- Ask whether the tree needs updating.",
    "- If the task changed decisions, constraints, rationale, ownership, or shared workspace relationships, open the tree PR first.",
    "- If the task changed only implementation details, skip the tree PR and open only the source/workspace code PR.",
    "",
    "<!-- END CONTEXT-TREE FRAMEWORK -->",
    "",
    "# Project-Specific Instructions",
    "",
    "<!-- Add your project-specific agent instructions below this line. -->",
    "",
  ].join("\n");
}

export function renderTreeProgress(): string {
  return [
    "# Progress",
    "",
    "- [x] Bootstrap the tree scaffolding",
    "- [x] Install first-tree skills and baseline instructions",
    "- [x] Scaffold default agent templates and org config",
    "",
  ].join("\n");
}
