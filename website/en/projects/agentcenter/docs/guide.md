---
title: UI guide
description: Walk through AGENTS.md, Skills, Providers, and the Claude, Codex, and Cursor special steps in the window.
---

# UI guide

> Who this is for: someone who already downloaded the exe and opened the agentcenter window.
>
> In one sentence: use the left menu, then click Apply to agents or Sync all before the change reaches each tool's config.
>
> Not here: where to download the exe. See [Download and open](./quickstart). Capability limits are in [Supported agents](./agents).
>
> Screenshots are full-window captures under `guide/img/`.

After the window opens, use these menu items:

| Menu | What it does |
| --- | --- |
| AGENTS mapping | Keep one instruction file and sync it to each agent |
| Skills | The central skill library, and a scan for scattered copies |
| Skills update | Check and update third-party skills through `npx skills` |
| Provider management | Maintain the provider pool (name, URL, key, models) |
| Enable providers | Choose providers per agent, then apply |
| Claude & Codex | Claude onboarding skip and Codex backend switch (also reachable from Enable providers) |
| MCP | MCP server pool and assignment |
| Token usage | Read usage from each agent when you turn it on |
| Git | Version history for `~/.agents` |

After you change an assignment, most pages need a second click. Providers and MCP use **Apply to agents**. Instruction files use **Sync all**.

---

## 1. AGENTS.md: edit the source and sync

Open **AGENTS mapping**.

![AGENTS mapping page](/projects/agentcenter/guide/img/01-agents-md.png)

1. **Source AGENTS.md** shows `~/.agents/AGENTS.md`. Click **Edit** to change it.
2. Click **Preview changes** when you want to see which files will move.
3. Click **Sync all**. The source file is mapped onto each agent that has an instruction path.
4. The table at the bottom lists each agent, target file, link kind, and whether it is still connected.

To stop one agent from using this file, unmap that row. Remap it later when you want it back. Details are in [AGENTS.md](./agents-md).

---

## 2. Skills: library, scattered copies, third-party updates

### 2.1 Central library

Open **Skills** (central library).

![Skills library](/projects/agentcenter/guide/img/02-skills.png)

1. The list is what already lives in `~/.agents/skills`.
2. Use the filters (All / Third-party / Local) and search to narrow it.
3. Click **Scan scattered skills** to find copies in agent folders.
4. **Collect into the library** only handles "not in the library yet" and "same contents". Conflicts stay manual.

### 2.2 Decide on scattered copies

After a scan, a dialog lists each copy:

![Scattered skill actions](/projects/agentcenter/guide/img/03-skills-scattered.png)

1. Not in the library yet: move it in, or delete it.
2. Same name with different contents: choose which copy stays.
3. Confirm before it runs; the disk is checked again at apply time.

### 2.3 Third-party updates

Open **Skills update**.

![Skills update](/projects/agentcenter/guide/img/04-skills-update.png)

1. Click **Check for updates**.
2. Then **Update selected** or **Update all**.
3. If an update replaces a link with a real folder, go back to AGENTS mapping and **Sync all** once more.

Details are in [Skills](./skills).

---

## 3. Providers: pool first, then enable

### 3.1 Maintain the pool

Open **Provider → Provider management**.

![Provider management](/projects/agentcenter/guide/img/05-providers.png)

1. These entries are `~/.agents/providers.toml`. Each keeps one key.
2. Click **Add provider**, or open a card to edit.
3. **Edit TOML** opens the file directly.

The add dialog looks like this:

![Add provider](/projects/agentcenter/guide/img/06-providers-add.png)

Fill in the id, display name, base URL, protocol, and API key. Models can be added later.

To set context window or output limit for a model:

![Add model metadata](/projects/agentcenter/guide/img/07-providers-add-model.png)

An empty field means "unspecified": apply keeps the value already in that agent's config.

This page does not decide which agents use a provider. That is the next page.

### 3.2 Enable per agent

Open **Provider → Enable providers**.

![Enable providers](/projects/agentcenter/guide/img/08-providers-enable.png)

1. Expand an agent and check the providers it should use.
2. Checking only updates the pool assignment.
3. Click **Apply to agents** to write each tool's config.
4. Exit ZCode, Pi, and opencode before you apply.

Agents marked **Single slot** can have only one provider at a time. Checking another clears the current one. Claude Code and Codex CLI are single-slot.

Details are in [Providers](./providers).

---

## 4. Claude Code special steps

Claude Code is single-slot: it only has one set of `ANTHROPIC_*` environment variables.

On **Enable providers**, expand **Claude Code**:

![Claude Code single slot and special entries](/projects/agentcenter/guide/img/09-claude-single-slot.png)

1. Pick one provider from the radio list. The protocol is on the right (`openai-responses`, `openai-chat`, and so on).
2. Click **Apply to agents**.
3. The two buttons at the bottom of the card (red arrows in the screenshot):
   - **First-run setup**: skip or restore Claude Code onboarding (`hasCompletedOnboarding` in `~/.claude.json`).
   - **Configure model mapping**: map model tiers for Claude.
4. The same settings are also under **Claude & Codex** in the sidebar.

The onboarding switch writes the local file immediately. It does not go through **Apply to agents**.

---

## 5. Codex CLI special steps

Codex is also single-slot, and its protocol is responses only. It only accepts one `model_providers` table at a time.

On **Enable providers**, expand **Codex CLI**:

![Codex backend switch](/projects/agentcenter/guide/img/10-codex-backend.png)

1. Pick one provider from the radio list.
2. Click **Apply to agents**.
3. Use **Backend switch** at the bottom of the card (red arrow in the screenshot):
   - **Auto**: follow whether an official login exists locally.
   - **Bypass ChatGPT backend**: use only the provider token. Use this with a third-party relay.
   - **Use ChatGPT backend**: send the official login. Do not pick this for a third-party endpoint.

If no provider is selected yet, the status says so. Select one, apply, then set the backend switch.

---

## 6. Cursor special steps

Cursor's own API key is outside **Apply to agents**. It lives in SQLite (`state.vscdb`), and Cursor must be fully quit before that file can be written.

### 6.1 Write from agentcenter

On **Enable providers**, scroll to **Cursor (own key)**:

![Cursor own key](/projects/agentcenter/guide/img/14-cursor-byok.png)

1. Read the warning at the bottom: do not write while Cursor is running. Quit the main window and the tray icon.
2. Choose the provider to write (the screenshot shows `command · CommandCode`).
3. Check the master switch, base URL, and key.
4. In the model list, check the models to add to Cursor. Models already present are labeled.
5. Click **Write to Cursor**.

The card also reminds you: after writing, turn on **Use OpenAI API Key** inside Cursor, or custom model names are rejected.

### 6.2 Turn the switch on in Cursor

Open Cursor → **Settings → Models**:

![Cursor Models settings](/projects/agentcenter/guide/img/15-cursor-settings.png)

1. Confirm the written model appears and is enabled (red arrow 1: `deepseek/deepseek-v4.1-flash`).
2. Turn on **Use OpenAI API Key** (red arrow 2). If the key is saved but this switch is still off, Cursor reports `Model name is not valid`.
3. If you need a custom endpoint, turn on **Override OpenAI Base URL** and enter the same base URL as the provider.

Cursor instruction files and MCP still use the shared sync. Only the own-key path uses this panel.

---

## 7. MCP

Open **MCP**:

![MCP pool](/projects/agentcenter/guide/img/11-mcp.png)

1. All MCP servers live in one pool.
2. Click **Assign** on a row and choose agents.
3. Click **Apply to agents** to write.
4. **Import from existing config** pulls servers already configured in each agent into the pool.

---

## 8. Token usage (optional)

Open **Token usage**:

![Token usage](/projects/agentcenter/guide/img/12-token-usage.png)

Nothing is read by default. Turn on the agents you care about, then read the trend or share charts. The numbers come from each agent's own session files.

---

## 9. Git (optional)

Open **Git**:

![Git](/projects/agentcenter/guide/img/13-git.png)

Use this for version history under `~/.agents`. Check the paths to commit, write a message, then commit. Push when you need to. It never runs `git add -A`.

---

## After you change something

| You just did | Check next |
| --- | --- |
| Edited AGENTS.md | Mapping rows still show as synced |
| Changed provider assignment | The agent can reach the new endpoint; ZCode / Pi / opencode were quit before apply |
| Wrote a Cursor key | After Cursor reopens, the switch and models are on |
| Updated a third-party skill | Whether instruction mapping needs another sync |
