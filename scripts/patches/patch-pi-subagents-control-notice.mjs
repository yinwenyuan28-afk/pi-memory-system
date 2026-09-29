#!/usr/bin/env node
// patch-pi-subagents-control-notice.mjs
//
// 目的：幂等补丁。让 pi-subagents 的前台「需要关注」告警不再插进工具调用中间。
//
// 背景：pi-subagents@0.35.1 的 src/extension/control-notices.ts 里，前台告警用
//       `pi.sendMessage(..., { triggerTurn: false })` 发送。而 pi 0.84.2 起，
//       AgentSession.sendCustomMessage 的分支是
//           else if (this.isStreaming && options?.triggerTurn !== false) { ...steer 排队... }
//           else { state.messages.push(); appendCustomMessageEntry(); }   ← 立刻写
//       即 triggerTurn:false 在流式期间**不再排队**，而是立刻写进 transcript。告警由
//       1 秒 debounce 的 setTimeout 发出，不挑时机；主代理若正挂在 subagent 工具调用上
//       （前台子代理最常见的状态），这条 custom_message 就落在 assistant(tool_calls)
//       与它的 toolResult 之间。convertToLlm 把它转成 role:"user"，provider 于是看到
//       assistant(tool_calls) → user → tool，直接 400：
//           Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
//       坏顺序一旦落盘，此后每轮请求都带着它 → 会话永久卡死。
//
// 补法：给前台分支加 `deliverAs: "nextTurn"` —— sendCustomMessage 的第一条分支就是
//       `deliverAs === "nextTurn"`，直接排队到下一轮用户消息时入列，永不落在工具批次
//       中间（代价：卡片不再立刻弹出，改为随下次用户消息出现；空闲时语义不变）。
//
// 行为：
//   - 已含补丁标记 deliverAs: "nextTurn" -> 视为已打，跳过（幂等，不改动文件）。
//   - 缺失且能找到锚点行                 -> 备份原文件后把锚点行替换为补丁块。
//   - 缺失且找不到锚点行                 -> 视为版本结构已变，报错退出，绝不盲目插入。
//
// 用法：
//   node patch-pi-subagents-control-notice.mjs            # 自动定位并应用
//   node patch-pi-subagents-control-notice.mjs --dry-run  # 只报告将要做什么，不写盘
//   node patch-pi-subagents-control-notice.mjs --target <path-to-control-notices.ts>  # 指定文件（测试用）
//   node patch-pi-subagents-control-notice.mjs --check    # 只体检：已打/未打，退出码 0/3
//
// 还原：把同目录生成的最新 control-notices.ts.bak-* 覆盖回 control-notices.ts 即可。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = 'deliverAs: "nextTurn"';
const ANCHOR_RE = /^(\s*)\{\s*triggerTurn:\s*input\.details\.source !== "foreground"\s*\},\s*$/;

function buildPatchBlock(ws) {
  return [
    `${ws}{`,
    `${ws}\ttriggerTurn: input.details.source !== "foreground",`,
    `${ws}\t// 本地补丁（scripts/patches/patch-pi-subagents-control-notice.mjs）：`,
    `${ws}\t// triggerTurn:false 在 pi 0.84.2 的 sendCustomMessage 里会落到 else 分支「立刻写进`,
    `${ws}\t// transcript」，可能插在 assistant(tool_calls) 与它的 toolResult 之间 → provider 报`,
    `${ws}\t// "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"`,
    `${ws}\t// 且坏顺序落盘后每轮都失败。deliverAs:"nextTurn" 改为排队到下一轮用户消息才入列`,
    `${ws}\t//（代价：这张卡片不再立刻弹出，改为随下次用户消息出现）。`,
    `${ws}\t...(input.details.source === "foreground" ? { deliverAs: "nextTurn" as const } : {}),`,
    `${ws}},`,
  ].join("\n");
}

function parseArgs(argv) {
  const args = { dryRun: false, check: false, target: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--check") args.check = true;
    else if (a === "--target") args.target = argv[++i];
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node patch-pi-subagents-control-notice.mjs [--dry-run|--check] [--target <path-to-control-notices.ts>]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`[WARN] 忽略未知参数: ${a}\n`);
    }
  }
  return args;
}

function discoverTarget() {
  const home = os.homedir();
  const rel = ["src", "extension", "control-notices.ts"];
  const roots = [
    path.join(home, ".pi", "agent", "npm", "node_modules", "pi-subagents"),
    path.join(home, ".pi", "agent", "node_modules", "pi-subagents"),
    path.join(home, ".pi", "npm", "node_modules", "pi-subagents"),
  ];
  for (const root of roots) {
    const candidate = path.join(root, ...rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.target ?? discoverTarget();
  if (!target) {
    process.stderr.write(
      "[ERROR] 找不到 pi-subagents 的 src/extension/control-notices.ts（已尝试常见安装路径）。\n" +
        "        请用 --target <path> 显式指定。\n",
    );
    process.exit(1);
  }
  if (!fs.existsSync(target)) {
    process.stderr.write(`[ERROR] 指定的目标文件不存在: ${target}\n`);
    process.exit(1);
  }
  process.stdout.write(`[INFO] 目标文件: ${target}\n`);

  const content = fs.readFileSync(target, "utf8");

  // 1) 已补丁：幂等退出
  if (content.includes(MARKER)) {
    process.stdout.write(`[OK] 补丁已就绪（检测到 ${MARKER}），无需修改。\n`);
    return;
  }
  if (args.check) {
    process.stderr.write('[FAIL] 补丁缺失（未检测到 deliverAs: "nextTurn"）：前台告警卡可能插进工具调用中间。\n');
    process.exit(3);
  }
  process.stdout.write(`[WARN] 未检测到补丁（${MARKER} 缺失）。\n`);

  // 2) 定位锚点（只匹配那一行单行选项对象；不匹配已改写的块）
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const anchorIdx = lines.findIndex((l) => ANCHOR_RE.test(l));
  if (anchorIdx === -1) {
    process.stderr.write(
      '[ERROR] 找不到锚点 { triggerTurn: input.details.source !== "foreground" }。\n' +
        "        可能是 pi-subagents 版本结构已变化，盲目写入会破坏源码。\n" +
        "        请手动检查该版本 control-notices.ts 的 deliverControlNotice 如何发送通知，再决定补法。\n",
    );
    process.exit(2);
  }

  const ws = lines[anchorIdx].match(/^(\s*)/)[1];
  const block = buildPatchBlock(ws);

  if (args.dryRun) {
    process.stdout.write(
      `[DRY-RUN] 将把第 ${anchorIdx + 1} 行替换为:\n${block}\n（不写入文件）\n`,
    );
    return;
  }

  // 3) 备份后替换
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${target}.bak-${stamp}`;
  fs.copyFileSync(target, bak);
  process.stdout.write(`[INFO] 已备份原文件: ${bak}\n`);

  lines.splice(anchorIdx, 1, ...block.split("\n"));
  fs.writeFileSync(target, lines.join(eol), "utf8");
  process.stdout.write(`[DONE] 已替换为补丁块（${MARKER}）。重启 pi 或 /reload 后生效。\n`);
}

main();
