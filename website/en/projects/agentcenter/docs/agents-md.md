---
title: AGENTS.md
description: Map one ~/.agents/AGENTS.md onto each agent's own instruction file.
---

# AGENTS.md

> Who this is for: someone who wants several agents to read the same global instructions.
>
> In one sentence: you edit `~/.agents/AGENTS.md`, and sync places it at each agent's own instruction file.
>
> Not here: which agents have an instruction file. See [Supported agents](./agents).
>
> Checked: 2026-11-16, against `src-tauri/src/doc.rs`, `config.rs`, and `link.rs`.

The source file is `~/.agents/AGENTS.md`. Edit that file in the window. If it does not exist yet, the window offers to create it. Create will not overwrite a file that is already there.

Sync maps that file onto each agent's instruction path. The paths are the Instruction file column in [Supported agents](./agents). Claude Code reads `CLAUDE.md`. The other agents that have this item read `AGENTS.md` in their own directory. Agents without a single instruction file are left out of this mapping.

If the target is already a normal file, sync first moves it to `~/.agents/backup/<timestamp>/`, then puts a link to the source file in its place. The old text is not deleted in place.

On Windows the attempt order is fixed. The window shows which one was used:

1. A symbolic link. That needs Developer Mode or an administrator.
2. A junction for a directory, or a hard link for a file. Those do not need extra permission.
3. A copy. After the source file changes, sync again so the copy catches up.

You can unmap one agent. That removes the link or copy at its target, and later syncs skip it. Remap builds the link again immediately.

To change one target path, write it in `~/.agents/agentcenter.toml`. Agents you do not list keep the default path from the table.

```toml
[source]
instructions = "~/.agents/AGENTS.md"

[[mappings]]
agent = "claude"
to    = "~/.claude/CLAUDE.md"
mode  = "auto"
disabled = false
```

The matching commands are:

```powershell
agentcenter status
agentcenter sync --dry-run
agentcenter sync
agentcenter unmap claude
agentcenter remap claude
```

`status` exits with code 2 when something needs attention. `--dry-run` lists the changes and does not write them.
