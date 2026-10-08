#!/usr/bin/env node
// l1-admin viewer-bridge：记忆库查看器的本地桥（静态托管 + 写盘 + 列目录）
//
// 职责：
//   ① 静态托管 {memoryDB}（viewers/*.html、viewers/assets/*、l1/records/*.jsonl、l1/hit-stats.json …）
//      —— 浏览器在 file:// 下既禁止 fetch 也禁止 ES module，所以查看器需要 http 才能自动加载。
//   ② 写盘：
//        POST /api/tombstone  {ids:[...]}                → tombstone.mjs（备份 + 就地标记 deleted）
//        POST /api/task-state {ids, state, reason?}      → task-state.mts（写锁 + 就地改 taskState + 审计）
//   ③ 列目录（只有服务端能列，浏览器列不了）：
//        GET /api/l1/shards   → l1/records/*.jsonl 全部文件名 + 行数（解开前端 60/90 天窗口）
//        GET /api/l2/blocks   → l2/scene-blocks 与 l2/archive 下的 .md 清单
//        GET /api/l3/backups  → backups/user-backups/ 清单
//   ④ 诊断：
//        GET /api/health         → {ok, profile}
//        GET /api/viewer-status  → 源码版本 vs 已部署版本（漂移检测）
//   ⑤ GET / → viewers/index.html（缺失回退 records-viewer.html）
//
// 用法：
//   node scripts/l1-admin/viewer-bridge.mjs [--port 5174] [--profile <dir>]
// 然后打开终端打印的 http://localhost:5174/viewers/index.html?port=5174
//
// 安全：仅绑定 127.0.0.1 本地回环；CORS 全放（本地工具）；勿暴露公网；用完关掉。
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const portArg = argv.indexOf("--port");
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) || 5174 : 5174;
const profileIdx = argv.indexOf("--profile");
const PROFILE = profileIdx >= 0 ? argv[profileIdx + 1] : "C:/Users/leaf/.pi/agent/profiles/default";
const MEMORY_DB = join(PROFILE, "memoryDB");
if (!existsSync(MEMORY_DB)) {
  console.error(`NG profile memoryDB 不存在：${MEMORY_DB}`);
  process.exit(2);
}

// 与 memory/paths.ts 同步：viewer 已迁入 memoryDB/viewers/
const VIEWER_DIR = "viewers";
const VIEWER_PAGE = "records-viewer.html";
const VIEWER_INDEX = "index.html";

const ID_RE = /^l1_[0-9a-z_]+$/;
const TASK_STATES = new Set(["open", "done", "dropped"]);
/** profile **根**下允许经 `/api/profile-files` 读取的文件（固定白名单，无路径参数 ⇒ 无遍历面）。 */
const PROFILE_ROOT_FILES = ["MEMORY.md", "USER.md", "USER-temp.md"];
// 需要 --experimental-strip-types 才能 import 扩展里的 .ts 实现（Node ≥22.13）
const STRIP_TYPES = ["--experimental-strip-types"];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".jsonl": "text/plain; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".sqlite": "application/octet-stream",
};

/** 统一响应：JSON + CORS。 */
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

/** 跑工具目录下的 CLI，捕获 stdout；失败时把 stderr/消息回给调用方。 */
function runCli(scriptArgs, timeoutMs = 60000) {
  try {
    const stdout = execFileSync(process.execPath, [...STRIP_TYPES, ...scriptArgs, "--profile", PROFILE], {
      cwd: TOOL_DIR,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout) };
  } catch (e) {
    const detail = [e && e.stdout, e && e.stderr, e && e.message].filter(Boolean).join("\n");
    return { ok: false, error: String(detail || e).slice(0, 600) };
  }
}

/** 从 CLI 的 stdout 里取 JSON —— **从第一个 `{` 起解析**。
 *
 * 为什么不能整段 JSON.parse：CLI 可能先打日志行（例如 `autoBackup` 的「已自动备份：…」），
 * 整段解析会失败并把一次成功的写盘报成 500。取第一个 `{` 起的内容即可兼容前置噪声。 */
function parseCliJson(stdout) {
  const text = String(stdout ?? "");
  const i = text.indexOf("{");
  if (i < 0) return null;
  try {
    return JSON.parse(text.slice(i));
  } catch {
    return null;
  }
}

/** 读请求体（JSON）。 */
function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve(null);
      }
    });
  });
}

/** 列目录下的文件名（带 size/mtime），只认指定扩展名。 */
function listDir(rel, exts) {
  const dir = join(MEMORY_DB, rel);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (exts && !exts.some((e) => name.toLowerCase().endsWith(e))) continue;
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      out.push({ file: name, size: st.size, mtime: st.mtime.toISOString() });
    } catch {
      /* 竞态忽略 */
    }
  }
  // 文件名即日期（YYYY-MM-DD.jsonl）时字典序即时间序
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

const server = createServer(async (req, res) => {
  const cors = () => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  };
  if (req.method === "OPTIONS") {
    cors();
    res.writeHead(204);
    res.end();
    return;
  }
  cors();

  const rawUrl = (req.url || "").split("?")[0];
  // **必须解码百分号编码**：`req.url` 是原始路径，而浏览器的 fetch/script src 会把非 ASCII 字符
  // 编码成 %XX（如中文文件名 `memory-system-个人开发者…md`）。不解码就会去找一个字面名为
  // `%E4%B8%AA…` 的文件 → 全部中文文件名的资源 404（L2 的块全是中文名，实测踩到）。
  // 解码后再交给 normalize + startsWith 守卫判定，`%2e%2e` 这类尝试仍会被拦下。
  let url = rawUrl;
  try {
    url = decodeURIComponent(rawUrl);
  } catch {
    /* 非法编码：按原样处理，交给后面的守卫与 404 分支 */
  }

  // ── 写盘：删除（tombstone.mjs：备份 + 就地标记 + 校验） ──
  if (req.method === "POST" && url === "/api/tombstone") {
    const body = await readBody(req);
    const ids = body && Array.isArray(body.ids) ? body.ids : null;
    if (!ids || ids.length === 0) return sendJson(res, 400, { success: false, error: "ids 数组必填" });
    const bad = ids.filter((x) => typeof x !== "string" || !ID_RE.test(x));
    if (bad.length > 0) return sendJson(res, 400, { success: false, error: "非法 id：" + bad.join(", ") });
    const r = runCli(["tombstone.mjs", ...ids, "--apply"]);
    if (!r.ok) return sendJson(res, 500, { success: false, error: r.error });
    return sendJson(res, 200, { success: true, detail: r.stdout.trim() });
  }

  // ── 写盘：任务状态（task-state.mts：写锁 + 就地改 taskState + taskStateChange 审计） ──
  // 注意与 tombstone 的差别：这条路径**取跨进程写锁**，拿不到锁时一条都不写。
  if (req.method === "POST" && url === "/api/task-state") {
    const body = await readBody(req);
    const ids = body && Array.isArray(body.ids) ? body.ids : null;
    const state = body && body.state;
    const reason = body && typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined;
    if (!ids || ids.length === 0) return sendJson(res, 400, { success: false, error: "ids 数组必填" });
    if (!TASK_STATES.has(state)) return sendJson(res, 400, { success: false, error: "state 只能是 open/done/dropped" });
    const bad = ids.filter((x) => typeof x !== "string" || !ID_RE.test(x));
    if (bad.length > 0) return sendJson(res, 400, { success: false, error: "非法 id：" + bad.join(", ") });
    const cliArgs = ["task-state.mts", ...ids, "--state", state, "--apply"];
    if (reason) cliArgs.push("--reason", reason);
    const r = runCli(cliArgs);
    // 脚本自身是 JSON 输出（成功/失败都结构化），优先透传；解析不出才用错误信息兜底。
    const parsed = parseCliJson(r.stdout);
    if (parsed) return sendJson(res, r.ok ? 200 : 500, parsed);
    return sendJson(res, 500, { success: false, error: r.error || "task-state 未返回可解析结果" });
  }

  if (req.method === "GET" && url === "/api/health") {
    return sendJson(res, 200, { ok: true, profile: PROFILE });
  }

  // ── 诊断：源码版本 vs 已部署版本（漂移检测） ──
  // 算法不在这里重算：转发给 viewer-status.mts，它 import 与部署同一份 scanViewerSource。
  if (req.method === "GET" && url === "/api/viewer-status") {
    const r = runCli(["viewer-status.mts"], 30000);
    if (!r.ok) return sendJson(res, 500, { success: false, error: r.error });
    try {
      return sendJson(res, 200, JSON.parse(r.stdout));
    } catch (e) {
      return sendJson(res, 500, { success: false, error: "viewer-status 输出不可解析：" + String(e && e.message) });
    }
  }

  // ── 列目录：L1 分片（解开前端的日期窗口限制） ──
  if (req.method === "GET" && url === "/api/l1/shards") {
    const dir = join(MEMORY_DB, "l1", "records");
    const shards = [];
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        try {
          const st = statSync(join(dir, name));
          if (!st.isFile()) continue;
          const text = readFileSync(join(dir, name), "utf-8");
          const rows = text.split("\n").filter((l) => l.trim()).length;
          shards.push({ file: name, rows, size: st.size, mtime: st.mtime.toISOString() });
        } catch {
          /* 读不了的跳过：宁可少一个分片，不让整次列举失败 */
        }
      }
      shards.sort((a, b) => a.file.localeCompare(b.file));
    }
    return sendJson(res, 200, { shards, total: shards.reduce((n, s) => n + s.rows, 0) });
  }

  // ── 活跃会话日（权威来源；侧车会滞后，见 active-days.mts 头部实测记录） ──
  if (req.method === "GET" && url === "/api/l1/active-days") {
    const r = runCli(["active-days.mts"], 30000);
    if (!r.ok) return sendJson(res, 500, { success: false, error: r.error });
    try {
      return sendJson(res, 200, JSON.parse(r.stdout));
    } catch (e) {
      return sendJson(res, 500, { success: false, error: "active-days 输出不可解析：" + String(e && e.message) });
    }
  }

  // ── 列目录：L2 场景块（live 与 archive） ──
  if (req.method === "GET" && url === "/api/l2/blocks") {
    return sendJson(res, 200, {
      live: listDir(join("l2", "scene-blocks"), [".md"]),
      archive: listDir(join("l2", "archive"), [".md"]),
    });
  }

  // ── 阈值与配置节（只回查看器要展示的数字；不暴露 config/ 整份文件，见 viewer-limits.mts 头部说明） ──
  if (req.method === "GET" && url === "/api/limits") {
    const r = runCli(["viewer-limits.mts"], 30000);
    if (!r.ok) return sendJson(res, 500, { success: false, error: r.error });
    try {
      return sendJson(res, 200, JSON.parse(r.stdout));
    } catch (e) {
      return sendJson(res, 500, { success: false, error: "viewer-limits 输出不可解析：" + String(e && e.message) });
    }
  }

  // ── 画像三件套（在 profile **根**，不在 memoryDB 下！） ──
  //
  // 为什么必须专门开这个端点：桥只挂载 `{memoryDB}`，而 `MEMORY.md` / `USER.md` / `USER-temp.md`
  // 位于 profile 根（memoryDB 的**上一级**）。页面里写 `../../USER.md` 在浏览器里只会解析成
  // `/USER.md`，落回桥根 = `{memoryDB}/USER.md` → 404。这正是 L3 页最初整段读不到画像文件的原因。
  // 这里按**固定文件名白名单**读取，不接受路径参数 ⇒ 不存在遍历面；也顺带避免了把 profile 根
  // 的其它目录（backups / deprecated / sub-memories）暴露出去。
  if (req.method === "GET" && url === "/api/profile-files") {
    const files = {};
    for (const name of PROFILE_ROOT_FILES) {
      try {
        files[name] = existsSync(join(PROFILE, name)) ? readFileSync(join(PROFILE, name), "utf-8") : null;
      } catch (e) {
        files[name] = null;
      }
    }
    return sendJson(res, 200, { files });
  }

  // ── 列目录：L3 画像备份 ──
  if (req.method === "GET" && url === "/api/l3/backups") {
    return sendJson(res, 200, { backups: listDir(join("backups", "user-backups"), [".md"]) });
  }

  // ── 静态托管 memoryDB（防止 path traversal） ──
  if (req.method === "GET") {
    // 根路径**重定向**到部署好的总览页，并且带上 ?port=。
    //
    // 不能就地返回 index.html：那份 HTML 里引用的是相对路径 `assets/viewer-core.js`，
    // 在 `/` 下会解析成 `/assets/…` —— 而静态托管的根是 memoryDB，资源实际在 `/viewers/assets/…`，
    // 于是 CSS/JS 全部 404、`window.V` 都不存在，页面是死的；同时缺 `?port=` 还会静默变只读。
    // 桥启动时打印的第一行就是这个根路径（终端里可点），踩中概率很高。
    if (url === "/") {
      const page = existsSync(join(MEMORY_DB, VIEWER_DIR, VIEWER_INDEX)) ? VIEWER_INDEX : VIEWER_PAGE;
      res.writeHead(302, { Location: `/${VIEWER_DIR}/${page}?port=${PORT}`, "Cache-Control": "no-store" });
      res.end();
      return;
    }
    const rel = url.replace(/^\/+/, "");
    // 静态托管**不覆盖 config/**：那份 JSONC 里有 model.embedding.apiKey，而本桥 CORS 全开地
    // 对本地回环服务整个 memoryDB —— 任何本地页面都能把它取走。查看器需要的东西一律走
    // /api/* 端点（如 /api/limits 只回几个阈值），所以这里直接拒绝，密钥不进响应。
    if (/^config([/\\]|$)/i.test(rel)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("forbidden: config/ 不经静态托管（含密钥，请用 /api/* 端点取所需分节）");
      return;
    }
    // 先按解码后的路径找；找不到再退回原始路径（少数客户端会把非 ASCII 字节直接发过来，
    // 浏览器不会这样，但手工 curl 会）。两者都要过 normalize + startsWith 守卫。
    // 第三种候选是为手工 curl 准备的：Node 把 `req.url` 里的原始 UTF-8 字节按 latin1 解成了字符串，
    // 按 utf8 重新解一次才能对上磁盘上的中文文件名（浏览器路径走第一种，不依赖这个）。
    const candidates = [rel];
    if (rawUrl !== url) candidates.push(rawUrl.replace(/^\/+/, ""));
    const latin1AsUtf8 = Buffer.from(rawUrl, "latin1").toString("utf8").replace(/^\/+/, "");
    if (!candidates.includes(latin1AsUtf8)) candidates.push(latin1AsUtf8);
    let served = false;
    for (const cand of candidates) {
      const fp = normalize(join(MEMORY_DB, cand));
      if (!fp.startsWith(normalize(MEMORY_DB))) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      if (existsSync(fp) && statSync(fp).isFile()) {
        const mime = MIME[extname(fp)] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
        res.end(readFileSync(fp));
        served = true;
        break;
      }
    }
    if (served) return;
    res.writeHead(404);
    res.end("not found");
    return;
  }

  res.writeHead(405);
  res.end("method not allowed");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[l1-admin viewer-bridge] 监听 127.0.0.1:${PORT}  profile=${PROFILE}`);
  console.log(`  打开：http://localhost:${PORT}/${VIEWER_DIR}/${VIEWER_INDEX}?port=${PORT}`);
  console.log(`  （根路径 http://localhost:${PORT}/ 会自动跳到上面这个地址 —— 别手改地址栏把 ?port= 删掉，`);
  console.log(`    删了页面不会报错，只会静默变只读、到处显示"无写盘桥"）`);
  console.log(`  写盘：POST /api/tombstone（删除）· POST /api/task-state（任务状态，带写锁）`);
  console.log(`  列目录：GET /api/l1/shards · /api/l2/blocks · /api/l3/backups · 诊断 /api/viewer-status`);
  console.log(`  关停：Ctrl+C`);
});
