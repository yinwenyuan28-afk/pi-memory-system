# pi-memory-system

L0–L3 记忆管线扩展。会话进行中自动提取原子记忆、整合进场景块、生成用户画像，并在后续轮次按需召回注入。

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| **操作系统** | **仅 Windows** | 停止子代理依赖 `taskkill /T /F` 的进程树语义；项目归属判定用盘符形状规则。见下方「已知限制」 |
| Node | `>= 22.13` | 用到内置的 `node:sqlite` |
| pi | 0.80+ | 扩展 API 与 `pi.events` 派发通道 |
| **pi-subagents** | **必需** | L1/L2/L3/review/skill-review 五条链靠后台子代理执行。派发走上游公开的 `subagents:rpc:v1` 事件总线 |

## 安装

```bash
# 从 npm（发布后）
pi install npm:pi-memory-system

# 从本地路径（开发 / 未发布时）
pi install ./path/to/memory-system
```

装完执行 `/reload`（或重启 pi）生效。

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
- **不依赖任何对 pi-subagents 源码的修改**。子代理派发走上游 README 明确提供给第三方扩展的 `subagents:rpc:v1` 事件总线。
- **不往 `~/.pi/agent/agents/` 写任何文件**。6 个子代理定义随包分发，激活时经上游的 `PI_SUBAGENT_EXTRA_AGENT_DIRS` 注册。若你曾在该目录手动放过同名定义，**以你的为准**（上游优先级：用户目录 > 插件自带）。
- **`vectorization` 默认关闭**。开启需要自备 OpenAI 兼容的 embedding 端点。

## 开发

```bash
npm run check-types   # 类型门禁（无构建仓库里唯一能拦住「名字写错/模块写错」的东西）
npm test              # 提示词契约逐字节校验
```

回归脚本在 `scripts/verify-*.ts`，需用 jiti 跑（扩展目录是 ESM，`.ts` 不能被 node 直跑）。
