---
title: Providers
description: Keep model access in one pool, then assign it to agents and write their config.
---

# Providers

> Who this is for: someone who wants one model key shared across agents, without typing it into each config file.
>
> In one sentence: keys live in one pool, you choose which agents use each key, and nothing is written until you apply.
>
> Not here: which agents can receive that write. See [Supported agents](./agents).
>
> Checked: 2026-11-16, against provider support in `src-tauri/src/agents/` and the assign flow in the repository README.

The pool is `~/.agents/providers.toml`. Each provider keeps one key, plus a name, a base URL, a default protocol, and a model list.

The window starts as a list. Changing one entry is two steps:

1. Click Assign on that row and choose the agents. This only updates the assignment in the pool.
2. Click Apply to agents. That writes each agent's config file.

The same URL can need a different protocol in another agent. Each provider has a default protocol, and an assigned agent can override it. The choices for an agent are only the protocols that agent can send. Codex has responses only. Claude Code can use anthropic, OpenAI Chat, or OpenAI Responses.

Claude Code and Codex can have only one provider at a time. Assigning a new one to them removes the previous assignment.

A model row can record context window, output limit, input types, and reasoning level. An empty field is left unchanged: apply keeps the value already in that agent's config.

## Before you apply

Exit ZCode, Pi, and opencode first. While they are running, they overwrite the files with the configuration they hold in memory.

From the command line, read the diff, then write:

```powershell
agentcenter providers diff
agentcenter providers sync --dry-run
agentcenter providers sync
```

Add one provider with:

```powershell
agentcenter providers set minimax --name "MiniMax" --base-url "https://api.minimax.cn/anthropic" --kind anthropic --api-key "sk-..." --models "MiniMax-M3" --agents "zcode,pi"
```

`--agent-kind pi=openai-responses` sets the protocol for one assigned agent.

## Cursor is outside this sync

Cursor's own API key lives in `state.vscdb`, and Cursor has to be fully quit before that file can be written. `providers sync` does not touch it.

Use the Cursor key section on the Providers page, or:

```powershell
agentcenter providers cursor status
agentcenter providers cursor plan command
agentcenter providers cursor apply command --models a,b
agentcenter providers cursor reset
```

If the key is set and "Use OpenAI API Key" is still off, Cursor reports `Model name is not valid`. `plan` lists the missing step first.
