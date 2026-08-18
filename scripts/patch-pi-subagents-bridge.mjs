#!/usr/bin/env node
// patch-pi-subagents-bridge.mjs
//
// 目的：幂等补丁。确保 pi-subagents 在扩展激活时把子代理执行器暴露到
//       globalThis.__piSubagentExecutor —— 这是 memory-system 扩展
//       memory/util/subagent.ts 桥接所依赖的契约。
//
// 背景：上游 pi-subagents@0.35.1 的 src/extension/index.ts 只声明
//       `executorExecute = executor.execute;`，但并未把它挂到 globalThis。
//       桥接 global 是本地补丁（紧跟在上面的赋值行之后）。一旦 pi-subagents
//       被 npm install / update 重装，node_modules 被清掉，补丁即丢失、
//       桥接断裂。本脚本用于在任何重装后把补丁幂等地补回来。
//
// 行为：
//   - 已含 __piSubagentExecutor -> 视为已补丁，跳过（幂等，不改动文件）。
//   - 缺失且能找到锚点行       -> 备份原文件后插入桥接行。
//   - 缺失且找不到锚点行       -> 视为版本结构已变，报错退出，绝不盲目插入。
//
// 用法：
//   node patch-pi-subagents-bridge.mjs            # 自动定位并应用
//   node patch-pi-subagents-bridge.mjs --dry-run  # 只报告将要做什么，不写盘
//   node patch-pi-subagents-bridge.mjs --target <path-to-index.ts>  # 指定文件（测试用）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BRIDGE_MARKER = "__piSubagentExecutor";
const ANCHOR_RE = /^\s*executorExecute = executor\.execute;\s*$/;

function buildInsertion(ws) {
  return `${ws}(globalThis as Record<string, unknown>)["${BRIDGE_MARKER}"] = executorExecute;`;
}

function parseArgs(argv) {
  const args = { dryRun: false, target: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--target") args.target = argv[++i];
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node patch-pi-subagents-bridge.mjs [--dry-run] [--target <path-to-index.ts>]\n",
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
  const candidates = [
    path.join(home, ".pi", "agent", "npm", "node_modules", "pi-subagents", "src", "extension", "index.ts"),
    path.join(home, ".pi", "agent", "node_modules", "pi-subagents", "src", "extension", "index.ts"),
    path.join(home, ".pi", "npm", "node_modules", "pi-subagents", "src", "extension", "index.ts"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.target ?? discoverTarget();
  if (!target) {
    process.stderr.write(
      "[ERROR] 找不到 pi-subagents 的 src/extension/index.ts（已尝试常见安装路径）。\n" +
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
  if (content.includes(BRIDGE_MARKER)) {
    process.stdout.write(`[OK] 桥接已就绪（检测到 ${BRIDGE_MARKER}），无需修改。\n`);
    return;
  }
  process.stdout.write(`[WARN] 未检测到桥接（${BRIDGE_MARKER} 缺失）。\n`);

  // 2) 定位锚点（仅匹配赋值语句，不匹配声明 / 调用 / 判空）
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const anchorIdx = lines.findIndex((l) => ANCHOR_RE.test(l));
  if (anchorIdx === -1) {
    process.stderr.write(
      "[ERROR] 找不到锚点 \"executorExecute = executor.execute;\"。\n" +
        "        可能是 pi-subagents 版本结构已变化，盲目插入会破坏源码。\n" +
        "        请手动检查该版本如何暴露执行器，再决定补丁方式。\n",
    );
    process.exit(2);
  }

  const ws = (lines[anchorIdx].match(/^(\s*)/) || ["", ""])[1];
  const insertion = buildInsertion(ws);

  if (args.dryRun) {
    process.stdout.write(
      `[DRY-RUN] 将在第 ${anchorIdx + 1} 行之后插入:\n  ${insertion}\n（不写入文件）\n`,
    );
    return;
  }

  // 3) 备份后插入
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${target}.bak-${stamp}`;
  fs.copyFileSync(target, bak);
  process.stdout.write(`[INFO] 已备份原文件: ${bak}\n`);

  lines.splice(anchorIdx + 1, 0, insertion);
  fs.writeFileSync(target, lines.join(eol), "utf8");
  process.stdout.write(`[DONE] 已插入桥接行:\n  ${insertion}\n`);
}

main();
