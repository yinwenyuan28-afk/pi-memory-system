---
title: Skill
description: 把散落在各 agent 目录里的 skill 收回 ~/.agents/skills，再逐条决定留哪一份。
---

# Skill

> 给谁：各家 agent 目录里都有一份 skill，想收成一个库的人。
>
> 一句话：先扫描散落副本，再逐条决定移入中心库、去重，还是采用哪一份。
>
> 不管：哪些 agent 会直接读中心库。见 [支持的 Agent](./agents)。
>
> 状态：2026-11-16 核对过仓库 README 的 skill 收集规则，以及 `reads_shared_skills` 的实现。

中心库在 `~/.agents/skills`。每个 skill 仍是一个目录，里面有 `SKILL.md`。标签写在 `~/.agents/agentcenter.toml` 的 `[skills.tags]`，不写进 skill 目录。写进目录会让后面的第三方更新报冲突。

## 扫描之后逐条处理

扫描会列出各 agent 目录里的副本，并按它和中心库的关系给出可选动作。同名但内容不同的，必须你自己选留哪一份。

| 扫描结果 | 可以做 |
| --- | --- |
| 中心库还没有 | 移入中心库，或删除这一份 |
| 内容相同 | 删掉副本、改成指向中心库的链接，或删除 |
| 同名，内容不同 | 采用散落的那一份、采用中心库的那一份，或删除 |
| 链接已经坏了 | 删除这条坏链接 |

采用散落版去覆盖中心库时，中心库里原来那一份会先复制到 `~/.agents/backup/`。选「删除」则不进备份，确认框里会写明这是真删除。

每次执行前都会再核对一次磁盘。对话框开着的时候文件可能已经变了，界面不拿旧的扫描结果直接写盘。

Pi、Codex、Cursor 和 opencode 会直接读 `~/.agents/skills`。其余有 skill 目录的 agent，要靠链接把中心库里的 skill 放到它们自己的 skills 目录。

## 第三方 skill 的更新

界面上的更新，封装的是 `npx skills`。它按内容哈希记版本，不是 `1.2.3` 这种版本号。更新完，如果链接被换回了真实目录，再跑一次指令映射的同步：

```powershell
agentcenter skills scan
agentcenter skills collect
agentcenter skills collect --apply
agentcenter skills check
agentcenter sync
```

`collect` 不加 `--apply` 只打印计划。`--apply` 才移动文件，而且只处理「中心库没有」和「内容相同」这两类。冲突的那一类要在界面上逐条选。
