# patches/ —— 给外部依赖打的本地补丁

这里放的是**依赖源码的本地补丁**（目前都是 pi-subagents）。它们改的是
`~/.pi/agent/npm/node_modules/pi-subagents/...` 里的文件，**不随本仓库走**：
pi 升级 / 重装该包后 node_modules 被覆盖，补丁就没了，得靠这些脚本幂等地补回来。

为什么用脚本而不是手改：这两处缺失都是**静默**的——桥接断了，memory-system 的跨进程
子代理调用失效；告警补丁丢了，告警卡可能插进工具调用中间把会话写坏（2026-09-27 已第三次
发作）。事后没人会想起"是重装冲掉的"。脚本还会在**找不到锚点行时报错退出**，版本结构变了
会直接挡住，绝不盲目往源码里插。

## 清单

| 脚本 | 补什么 | 丢了会怎样 |
|---|---|---|
| `patch-pi-subagents-bridge.mjs` | pi-subagents 激活时把子代理执行器挂到 `globalThis.__piSubagentExecutor`（memory-system 的 `memory/util/subagent.ts` 桥接依赖这个契约） | 桥接断裂，memory-system 的子代理调用失效 |
| `patch-pi-subagents-control-notice.mjs` | 前台「需要关注」告警加 `deliverAs: "nextTurn"` 排队，不再「立刻写进 transcript」 | 告警卡可能落在 `assistant(tool_calls)` 与它的 `toolResult` 之间 → provider 报 `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'` → 会话永久卡死 |

## 用法

两个脚本都**幂等**：已打过会打印 `[OK] ...` 直接退出，重复跑无害。

```bash
cd ~/.pi/agent/extensions/memory-system/scripts/patches
node patch-pi-subagents-bridge.mjs
node patch-pi-subagents-control-notice.mjs
```

- `--dry-run` 只报告将要改什么，不写盘
- `--check`（仅 control-notice 脚本）只体检：已打退出码 0 / 未打退出码 3
- `--target <文件>` 指定目标文件（测试用）
- 每次写入前备份为 `<目标>.bak-<时间戳>`；要还原就把它覆盖回原文件名

**什么时候必须重跑**：pi 升级或重装 pi-subagents 之后（pi 的包管理、`npm update` 都会覆盖
node_modules），以及脚本报 `[WARN] 未检测到补丁` 时。

**生效条件**：重启 pi，或 `/reload`（node_modules 里的 `.ts` 由 jiti 直接加载，改了要重新加载）。

## 相关

- 会话**已经**被插坏了（不是补丁的问题，是历史上已经坏了）：先用
  `~/.pi/agent/scripts/check-session-order.mjs` 定位是哪个会话，再
  `node ~/.pi/agent/scripts/repair-session-order.mjs "<文件>" --apply`，然后重启 pi。
- 补丁与脚本的关系：`control-notice` 那处只堵住「前台告警」这个来源；同类形状的隐患还有
  pi-goal 的 `set_goal` 工具（模型在对话中调用它时走同一条立即写入的路，本机尚未发作）。
