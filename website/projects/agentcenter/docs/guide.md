---
title: 界面操作指南
description: 按窗口左侧菜单，走一遍 AGENTS.md、Skill、Provider，以及 Claude、Codex、Cursor 的特殊操作。
---

# 界面操作指南

> 给谁：已经下载好 exe、打开了 agentcenter 窗口的人。
>
> 一句话：左侧菜单点进对应页，改完点「应用到各 agent」或「同步全部」才真正写进各家配置。
>
> 不管：从哪下载 exe。见 [下载与打开](./quickstart)。各家能力边界见 [支持的 Agent](./agents)。
>
> 状态：截图为完整窗口；文件在 `guide/img/`。

打开窗口后，左侧是菜单。常用这几项：

| 菜单 | 做什么 |
| --- | --- |
| AGENTS文档映射 | 维护一份母版指令，同步到各 agent |
| Skills | 中心库里的 skill，以及扫描散落副本 |
| Skills 更新 | 用 `npx skills` 检查和更新第三方 skill |
| provider 管理 | 维护 provider 池（名字、地址、密钥、模型） |
| 启用 provider | 给每家 agent 勾选要用的 provider，再点应用 |
| Claude & Codex | Claude 首次引导、Codex 后端开关（也可从启用页按钮进入） |
| MCP | MCP server 池和分配 |
| Token 用量 | 按需读取各 agent 的用量 |
| Git | `~/.agents` 的版本管理 |

改完分配之后，多数页都要再点一次确认按钮。Provider 和 MCP 点 **应用到各 agent**。指令文件点 **同步全部**。

---

## 1. AGENTS.md：改母版并同步

打开 **AGENTS文档映射**。

![AGENTS文档映射页](/projects/agentcenter/guide/img/01-agents-md.png)

1. 上方 **母版 AGENTS.md** 显示的是 `~/.agents/AGENTS.md`。点 **编辑** 改内容。
2. 需要先看会改哪些文件时，点 **预览变更**。
3. 确认后点 **同步全部**。母版会映射到各家有指令文件的目标路径。
4. 页面下方是映射表：每家 agent、目标文件、链接方式、是否还连着。

某家暂时不要这份指令：在映射表里取消那一家。恢复时再把它映射回来。细则见 [AGENTS.md](./agents-md)。

---

## 2. Skill：中心库、散落副本、第三方更新

### 2.1 中心库

打开 **Skills**（中心库）。

![Skills 中心库](/projects/agentcenter/guide/img/02-skills.png)

1. 列表里是 `~/.agents/skills` 里已经收回来的 skill。
2. 可用顶部筛选（全部 / 第三方 / 本地自建）和搜索缩小范围。
3. 点 **扫描散落 skill**，看各 agent 目录里还有没有副本。
4. **一键收集到中心库** 只处理「中心库没有」和「内容相同」两类。冲突不自动处理。

### 2.2 处置散落副本

扫描之后会弹出处置窗口，逐条选择：

![散落 skill 处置](/projects/agentcenter/guide/img/03-skills-scattered.png)

1. 中心库还没有的：选 **移入中心库** 或删除。
2. 同名内容不同的：必须自己选采用哪一份。
3. 确认后再执行；执行前会再核对一次磁盘。

### 2.3 第三方更新

打开 **Skills 更新**。

![Skills 更新](/projects/agentcenter/guide/img/04-skills-update.png)

1. 点 **检查更新**。
2. 再 **更新选中** 或 **更新全部**。
3. 更新完如果链接被换成真实目录，回到 AGENTS文档映射再 **同步全部** 一次。

细则见 [Skill](./skills)。

---

## 3. Provider：先管池子，再启用

### 3.1 维护池子

打开 **Provider → provider 管理**。

![provider 管理](/projects/agentcenter/guide/img/05-providers.png)

1. 这里是 `~/.agents/providers.toml` 里的条目。每条只留一把 key。
2. 点 **新增 provider** 加一条；已有的点卡片进对话框改。
3. 也可以 **编辑 TOML** 直接改文件。

新增时对话框大致如下：

![新增 provider](/projects/agentcenter/guide/img/06-providers-add.png)

填写标识、显示名、Base URL、协议、API Key。模型可以后补。

需要给某个模型写上下文窗口、输出上限时，用添加模型对话框：

![添加模型元数据](/projects/agentcenter/guide/img/07-providers-add-model.png)

留空表示这一项不指定，应用时沿用该 agent 配置里已有的值。

这一页不决定哪家 agent 在用。分配在下一页。

### 3.2 按 agent 启用

打开 **Provider → 启用 provider**。

![启用 provider](/projects/agentcenter/guide/img/08-providers-enable.png)

1. 按 agent 分组。展开某一家，勾选它要用的 provider。
2. 勾选只改母版里的分配。
3. 点右上角 **应用到各 agent**，才写进各家配置文件。
4. 应用前先退出正在跑的 ZCode、Pi、opencode。

带 **单槽位** 标记的 agent，同一时刻只能有一家 provider。勾另一个会自动取消当前的。Claude Code 和 Codex CLI 都是单槽位。

细则见 [Provider](./providers)。

---

## 4. Claude Code 的特殊操作

Claude Code 是单槽位：配置里只有一组 `ANTHROPIC_*` 环境变量。

在 **启用 provider** 里展开 **Claude Code**：

![Claude Code 单槽位与专属入口](/projects/agentcenter/guide/img/09-claude-single-slot.png)

1. 用单选列表挑一家 provider。协议列在右侧（如 `openai-responses`、`openai-chat`）。
2. 点 **应用到各 agent**。
3. 卡片底部两个按钮（图中红箭头）：
   - **首次引导设置**：跳过或恢复 Claude Code 首次引导（写 `~/.claude.json` 的 `hasCompletedOnboarding`）。
   - **配置档位映射**：给 Claude 配模型档位。
4. 也可以从侧栏 **Claude & Codex** 进同一套专属设置。

这和用哪家 provider 无关的引导开关，改完立即写本机文件，不经过「应用到各 agent」。

---

## 5. Codex CLI 的特殊操作

Codex 也是单槽位，而且协议只能是 responses。一次只认一张 `model_providers` 表。

在 **启用 provider** 里展开 **Codex CLI**：

![Codex 后端开关](/projects/agentcenter/guide/img/10-codex-backend.png)

1. 用单选列表勾选一家 provider。
2. 点 **应用到各 agent**。
3. 卡片底部的 **后端开关**（图中红箭头）用来决定是否绕过 ChatGPT 后端：
   - **自动**：看本机有没有官方登录。
   - **绕过 ChatGPT 后端**：只用 provider 里的 token。接第三方中转时用这个。
   - **走 ChatGPT 后端**：带着官方登录去请求。接第三方端点时不要选。

还没勾选任何 provider 时，状态会显示「还没有启用任何 provider」。先勾选再应用，再调后端开关。

---

## 6. Cursor 的特殊操作

Cursor 的自带密钥不走「应用到各 agent」。配置在 SQLite（`state.vscdb`）里，而且要先完全退出 Cursor 才能写。

### 6.1 在 agentcenter 里写入

打开 **启用 provider**，往下滚到 **Cursor（自带密钥）**：

![Cursor 自带密钥](/projects/agentcenter/guide/img/14-cursor-byok.png)

1. 看页脚警告：Cursor 还开着时不要写。要退出主窗口，也要退出托盘图标。
2. 在下拉里选要写入的那条 provider（图中是 `command · CommandCode`）。
3. 核对总开关、接口地址、密钥是否齐。
4. 在模型选择器里勾选要加进 Cursor 的模型；已在 Cursor 里的会标出来。
5. 点 **写入 Cursor**。

卡片上的说明也会提醒：写入后还要在 Cursor 里打开「Use OpenAI API Key」，否则自定义模型名会被拒。

### 6.2 在 Cursor 里打开开关

打开 Cursor → **Settings → Models**：

![Cursor Models 设置](/projects/agentcenter/guide/img/15-cursor-settings.png)

1. 确认写入的模型已出现在列表里，并已打开（图中红箭头 1：`deepseek/deepseek-v4.1-flash`）。
2. 打开 **Use OpenAI API Key**（图中红箭头 2）。只保存了密钥、这个开关仍关着时，会报 `Model name is not valid`。
3. 需要改地址时，打开 **Override OpenAI Base URL**，填入与 provider 一致的接口地址。

Cursor 的指令文件和 MCP 仍走通用同步；只有自带密钥走这一块。

---

## 7. MCP

打开 **MCP**：

![MCP 池与分配](/projects/agentcenter/guide/img/11-mcp.png)

1. 所有 MCP server 在一个池子里。
2. 点某一行的 **分配**，勾选要用它的 agent。
3. 点 **应用到各 agent** 才写入。
4. 也可以 **从现有配置导入**，把各家已经配好的 server 收进池子。

---

## 8. Token 用量（可选）

打开 **Token 用量**：

![Token 用量](/projects/agentcenter/guide/img/12-token-usage.png)

默认不读任何一家。需要统计时，先打开对应 agent 的开关，再看折线或占比。数据来自各 agent 自己写的会话文件，不是 agentcenter 另记账。

---

## 9. Git（可选）

打开 **Git**：

![Git 版本管理](/projects/agentcenter/guide/img/13-git.png)

用来给 `~/.agents` 做版本管理。勾选要提交的路径，写说明后提交；需要时再推送。不会自动 `git add -A`。

---

## 改完之后建议核对

| 刚做完的事 | 建议再看一眼 |
| --- | --- |
| 改了 AGENTS.md | 映射表里目标状态是否仍是已同步 |
| 改了 provider 分配 | 对应 agent 能不能用上新的端点；应用前是否已退出 ZCode / Pi / opencode |
| 改了 Cursor 密钥 | Cursor 重新打开后，开关和模型是否生效 |
| 更新了第三方 skill | 是否需要再同步一次指令映射 |
