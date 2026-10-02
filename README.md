# pi-memory-system

L0–L3 记忆管线扩展。会话进行中自动提取原子记忆、整合进场景块、生成用户画像，并在后续轮次按需召回注入。

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| **操作系统** | **仅 Windows** | 停止子代理依赖 `taskkill /T /F` 的进程树语义；项目归属判定用盘符形状规则。见下方「已知限制」 |
| Node | `>= 22.13` | 用到内置的 `node:sqlite` |
| pi | **实测可用**：pi 0.84.2 + pi-coding-agent 0.83.0 + pi-ai 0.74.2 | 扩展 API。**不需要额外安装任何 `@earendil-works/*`**——pi 的扩展加载器通过 jiti 别名 / Bun 虚拟模块把这些包指向它自己 bundle 的副本，扩展 import 它们不落 `node_modules`。这条是实测的：发布产物装在一条向上五级都没有 `node_modules` 的路径上，仍 0 错误加载、18 工具 + 16 命令全在位 |

**不依赖 pi-subagents**（2026-10-01 起）。L1/L2/L3/review/skill-review 五条链的后台子代理由本扩展**自己 spawn 一个 pi 子进程**执行（`util/spawn.ts`），不需要安装、也不需要修改任何其它扩展的源码。

> 此前版本走 pi-subagents 的 `subagents:rpc:v1` 事件总线，已移除——该桥接层硬编码从自己缓存里取 ctx，而 pi 会在 session 替换/reload 时作废该缓存，导致派发必然失败（`This extension ctx is stale…`）。详见 `plan/memory-system/SELF_SPAWN_PLAN.md`。

## 安装

```bash
# 从 npm（发布后）
pi install npm:pi-memory-system

# 从本地路径（开发 / 未发布时）
pi install ./path/to/memory-system
```

装完执行 `/reload`（或重启 pi）生效。

> **`pi install` 不接受 `.tgz` 路径**（2026-10-02 实测）。喂 tarball 的话 pi 只是把
> `xxx.tgz` 原样写进 `settings.packages` 的相对路径，加载器随后报
> `Unknown file extension ".tgz"` —— 装是"成功"了，但扩展永远加载不上。
> 要用 tarball 就先解包，再按**目录**装：`tar -xzf x.tgz && pi install ./package`。

### ⚠ 只用一种安装方式

pi 会**同时**扫描 `~/.pi/agent/extensions/` 目录和 `settings.json` 的 `packages` 数组。如果扩展同时存在于两处，pi 会加载两次 ⇒ **同名工具重复注册**（pi 的去重按路径，两条路径不同不去重）。

从 `extensions/` 目录迁到包安装时，**先删掉旧目录**：

```bash
mv ~/.pi/agent/extensions/memory-system /path/to/backup
```

确认无误后再执行 `pi install`。

## 配置

配置文件在 profile 目录下（**首次运行自动创建**）：

```
<agentDir>/profiles/<profile>/memoryDB/config/application-propertis.json
```

JSONC 格式（支持 `//` 注释）。四个节：

| 节 | 作用 | 缺省会怎样 |
|---|---|---|
| `recall` | 召回闸门：相似度下限、注入条数上限、注入超时与模式 | 全部回落到内置默认，**不崩** |
| `vectorization` | 向量化开关与触发阈值 | 默认关闭，**不崩** |
| `subagent` | 子代理存活门控：软/硬阈值、停止序列宽限 | 全部回落到内置默认 |
| `model` | `llm`（后台模型）与 `embedding`（向量化服务） | `llm` 缺省跟随前台模型；**`embedding` 的 `url` / `apiKey` 缺失时，用到向量化的功能会抛错** |

配置项的完整语义见各节源码注释（`config/app-config.ts`）。

## 已知限制

- **仅支持 Windows**。项目归属判定依赖盘符形状（`C:/`）识别「用户主目录类噪声路径」；在 Linux/macOS 上这些规则**静默失效**——不报错，但项目判定会变差。子代理停止序列同样按 Windows 的进程树语义设计。
- **不往 `~/.pi/agent/agents/` 写任何文件**。6 个子代理定义随包分发（`agents/*.md`），派发时由本扩展直接读取。
- **会往宿主 `~/.pi/agent/settings.json` 写，且只写一个键**：`memorySystem.activeProfile`（记录当前激活的记忆 profile，`/my-memory:profile switch` 会改它；没切过就完全不写）。**不做整文件覆写**——直接在原始文本上定位那个值、只替换那一段，其余字节原样保留；落盘走 tmp → rename 原子写。键挂在自己的命名空间下，将来要整个摘掉只需去掉那个对象。若该文件不可写，切换会**如实报错并回滚**（不会假装成功）。
- **pi 可执行文件的定位**优先用 `process.execPath` + pi 自己的入口（最可靠，因为扩展就跑在 pi 进程里）；PATH 里的 `pi` 位置带包管理器的会话哈希、跨窗口不稳定，只作回落。必要时可用 `PI_MEMORY_SYSTEM_PI_BIN` 指定。
- **`vectorization` 默认关闭**。开启需要自备 OpenAI 兼容的 embedding 端点。

## 开发

```bash
npm run check-types   # 类型门禁（无构建仓库里唯一能拦住「名字写错/模块写错」的东西）
npm test              # 提示词契约逐字节校验
```

回归脚本在 `scripts/verify-*.ts`，需用 jiti 跑（扩展目录是 ESM，`.ts` 不能被 node 直跑）。
