---
title: Supported agents
description: Which agents agentcenter can update for instruction files, providers, skills, and MCP.
---

# Supported agents

> Who this is for: someone checking which settings agentcenter can write for the tool they already use.
>
> In one sentence: each agent accepts a different set of settings, and these two tables are the list.
>
> Not here: how to perform each action. Instruction files are in [AGENTS.md](./agents-md), model access is in [Providers](./providers), and skills are in [Skills](./skills).
>
> Checked: 2026-11-16, against each agent implementation under `src-tauri/src/agents/`.

"Yes" means that item can be written for this agent. "No" means it is not done.

## Checked against files on a machine that has the tool

| Agent | Instruction file | Provider | Skill | MCP |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` | Yes, one provider at a time | Yes | Yes |
| Codex CLI | `~/.codex/AGENTS.md` | Yes, one provider at a time, responses only | Yes, reads the central library | Yes |
| ZCode | `~/.zcode/AGENTS.md` | Yes | Yes | Yes |
| pi | `~/.pi/agent/AGENTS.md` | Yes | Yes, reads the central library | Yes |
| opencode | `~/.config/opencode/AGENTS.md` | Yes | Yes, reads the central library | Yes |
| DSH | `~/.dsh/AGENTS.md` | Yes | Yes | Yes |
| Hermes Agent | No single instruction file | Yes | Yes | Yes |
| WorkBuddy | No single instruction file | Yes | Yes | Yes |
| Cursor | `~/.cursor/AGENTS.md` | Not in the shared sync; see [Providers](./providers) | Yes, reads the central library | Yes |
| Qoder | No user-level instruction file | No | Yes | Yes |
| Zed | `%APPDATA%\Zed\AGENTS.md` | No | Yes | No |

Exit ZCode, Pi, and opencode before syncing providers or MCP. While they are running, they write the configuration they hold in memory back to disk. Exit Cursor completely before writing its own API key.

## Wired up, not yet checked against a real install

These writers follow another tool's config shape. After you install one, check it against the real files.

| Agent | Instruction file | Provider | Skill | MCP |
| --- | --- | --- | --- | --- |
| Gemini CLI | `~/.gemini/AGENTS.md` | Yes, one provider at a time | Yes | Yes |
| Grok Build | No | Yes, one provider at a time | Yes | Yes |
| OpenClaw | No | Yes | Yes | No |
| Kimi Code | No | Yes | Yes | Yes |
| MiniMax Code | No | Yes | Yes | Yes |
| Qoder CN | `~/.qoder-cn/AGENTS.md` | No | Yes | No |
| Trae CN | `~/.trae-cn/AGENTS.md` | No | Yes | No |
| CodeBuddy | No | No | Yes | No |

If the config directory exists, the app treats that agent as installed. You can still assign an agent that is not installed; the files are written when you sync on a machine that has it.
