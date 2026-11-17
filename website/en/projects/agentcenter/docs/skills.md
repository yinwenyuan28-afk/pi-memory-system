---
title: Skills
description: Gather skills scattered across agent folders into ~/.agents/skills, then choose which copy to keep.
---

# Skills

> Who this is for: someone who has a copy of the same skill in several agent folders and wants one library.
>
> In one sentence: scan the scattered copies, then decide one by one whether to move, dedupe, or keep a chosen copy.
>
> Not here: which agents read the central library directly. See [Supported agents](./agents).
>
> Checked: 2026-11-16, against the skill rules in the repository README and the `reads_shared_skills` implementations.

The library is `~/.agents/skills`. Each skill is still a folder with a `SKILL.md`. Tags live in `[skills.tags]` inside `~/.agents/agentcenter.toml`, not inside the skill folder. A tag file inside the folder makes a later third-party update report a conflict.

## Decide one row at a time

A scan lists the copies it finds and offers actions based on how each copy relates to the library. When the name matches and the contents differ, you choose which copy stays.

| Scan result | Actions |
| --- | --- |
| Not in the library yet | Move it in, or delete it |
| Same contents | Delete the copy and link it to the library, or delete it |
| Same name, different contents | Keep the scattered copy, keep the library copy, or delete |
| Broken link | Delete the broken link |

When the scattered copy replaces the library copy, the previous library copy is copied to `~/.agents/backup/` first. Delete does not go into that backup. The confirmation says so.

Each action checks the disk again before it writes. Files can change while the dialog is open, so the window does not trust the earlier scan.

Pi, Codex, Cursor, and opencode read `~/.agents/skills` directly. Other agents that have a skills folder receive a link into their own skills folder.

## Updates from other people

The update action wraps `npx skills`. It records a content hash, not a version such as `1.2.3`. After an update, if a link was replaced by a real folder, sync the instruction mappings again:

```powershell
agentcenter skills scan
agentcenter skills collect
agentcenter skills collect --apply
agentcenter skills check
agentcenter sync
```

`collect` without `--apply` only prints the plan. `--apply` moves files, and only for "not in the library yet" and "same contents". Name conflicts are chosen one by one in the window.
