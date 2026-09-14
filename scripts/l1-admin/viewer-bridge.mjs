#!/usr/bin/env node
// l1-admin viewer-bridge：记录查看器的本地写盘桥
// 职责：① 静态托管 memoryDB（viewers/records-viewer.html / l1/records/*.jsonl / l1/hit-stats.json）
//       ② POST /api/tombstone {ids:[...]} → 真实落盘（tombstone.mjs：自动备份 + 跨进程写锁 + 就地标记 + 校验）
// 用法：
//   node viewer-bridge.mjs [--port 5174] [--profile <dir>]
// 然后浏览器打开 http://localhost:5174/records-viewer.html?port=5174
//   或 file:// 打开 records-viewer.html 后追加 ?port=5174（file 模式仅删除走桥，加载仍受浏览器限制）
// 安全：仅绑定 127.0.0.1 本地回环；CORS 全放（本地工具）；勿暴露公网；用完关掉。
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const portArg = argv.indexOf("--port");
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) || 5174 : 5174;
const profileIdx = argv.indexOf("--profile");
const PROFILE = profileIdx >= 0 ? argv[profileIdx + 1] : "C:/Users/leaf/.pi/agent/profiles/default";
const MEMORY_DB = join(PROFILE, "memoryDB");
if (!existsSync(MEMORY_DB)) { console.error(`NG profile memoryDB 不存在：${MEMORY_DB}`); process.exit(2); }
// 与 memory/paths.ts 同步：viewer 已迁入 memoryDB/viewers/
const VIEWER_DIR = "viewers";
const VIEWER_PAGE = "records-viewer.html";

const ID_RE = /^l1_[0-9a-z_]+$/;
const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".jsonl": "text/plain; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".sqlite": "application/octet-stream" };

const server = createServer((req, res) => {
  const cors = () => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  };
  if (req.method === "OPTIONS") { cors(); res.writeHead(204); res.end(); return; }
  cors();

  const url = (req.url || "").split("?")[0];

  // ── 删除 API：真实落盘（tombstone.mjs：备份 + 写锁 + 就地标记 + 校验） ──
  if (req.method === "POST" && url === "/api/tombstone") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { ids } = JSON.parse(body || "{}");
        if (!Array.isArray(ids) || ids.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "ids 数组必填" }));
          return;
        }
        const bad = ids.filter((x) => typeof x !== "string" || !ID_RE.test(x));
        if (bad.length > 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "非法 id：" + bad.join(", ") }));
          return;
        }
        const stdout = execFileSync(
          process.execPath,
          ["tombstone.mjs", ...ids, "--apply", "--profile", PROFILE],
          { cwd: TOOL_DIR, encoding: "utf8", timeout: 60000 },
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, detail: String(stdout).trim() }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: String((e && e.message) || e).slice(0, 300) }));
      }
    });
    return;
  }

  if (req.method === "GET" && url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, profile: PROFILE }));
    return;
  }

  // ── 静态托管 memoryDB（防止 path traversal） ──
  if (req.method === "GET") {
    const rel = url === "/" ? `${VIEWER_DIR}/${VIEWER_PAGE}` : url.replace(/^\/+/, "");
    const fp = normalize(join(MEMORY_DB, rel));
    if (!fp.startsWith(normalize(MEMORY_DB))) {
      res.writeHead(403); res.end("forbidden"); return;
    }
    if (existsSync(fp) && statSync(fp).isFile()) {
      const mime = MIME[extname(fp)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
      res.end(readFileSync(fp));
      return;
    }
    res.writeHead(404); res.end("not found");
    return;
  }

  res.writeHead(405); res.end("method not allowed");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[l1-admin viewer-bridge] http://127.0.0.1:${PORT}  profile=${PROFILE}`);
  console.log(`  打开查看器：http://localhost:${PORT}/${VIEWER_DIR}/${VIEWER_PAGE}?port=${PORT}`);
  console.log(`  删除 = POST /api/tombstone {ids:[...]} → tombstone.mjs（自动备份+写锁+就地标记）`);
  console.log(`  关停：Ctrl+C`);
});