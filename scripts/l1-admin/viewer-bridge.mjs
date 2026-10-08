#!/usr/bin/env node
// l1-admin viewer-bridge：记忆库查看器的本地桥（静态托管 + 写盘 + 列目录 + 诊断）
//
// 职责：
//   ① 静态托管 {memoryDB}（viewers/*.html、viewers/assets/*、l1/records/*.jsonl、l1/hit-stats.json …）
//      —— 浏览器在 file:// 下既禁止 fetch 也禁止 ES module，所以查看器需要 http 才能自动加载。
//   ② 写盘（全部经 `scripts/l1-admin/*.mts|*.mjs` 转发，桥内**不复制任何业务逻辑**）：
//        POST /api/tombstone          {ids}                       删除（墓碑，支持批量）
//        POST /api/task-state         {ids, state, reason?}        任务状态（带 L1 写锁）
//        POST /api/l1/fix             {id, action, content?, evidence, …, apply}
//        POST /api/l1/rollback        {backup, apply, confirm}     整库还原（confirm = 备份目录名）
//        POST /api/l1/embedding       {op, apply, confirm}         向量回填 / 重建（重建要 confirm=REBUILD）
//        POST /api/l1/mode            {mode}                       L1 提取模式 code|chat
//        POST /api/trigger            {layer, reason?}             请求入队（落盘信号，非立即执行）
//        POST /api/subagent/stop      {layer, job?, reason?}       停掉某层子代理
//        POST /api/l2/archive         {filename, reason, apply}    块归档
//        POST /api/l2/restore         {filename, reason?, apply}   块恢复
//        POST /api/l2/scene-pool/seed {scenes, apply}              场景池播种
//        POST /api/l3/edit            {action, content?, target?} 提议稿条目增删改
//        POST /api/l3/restore         {file, apply, confirm, …}    提议稿还原（confirm = 备份文件名）
//        POST /api/l3/merge           {apply, confirm, …}          并入 live USER.md（confirm = MERGE）
//   ③ 列目录（只有服务端能列，浏览器列不了）：
//        GET /api/l1/shards   → l1/records/*.jsonl 全部文件名 + 行数（解开前端 60/90 天窗口）
//        GET /api/l1/backups  → backups/l1-admin/* 备份目录（还原面板的候选）
//        GET /api/l2/blocks   → l2/scene-blocks 与 l2/archive 下的 .md 清单
//        GET /api/l3/backups  → backups/user-backups/ 清单
//   ④ 诊断：
//        GET /api/health            → {ok, profile}
//        GET /api/viewer-status     → 源码版本 vs 已部署版本（漂移检测）
//        GET /api/limits            → 阈值与配置节（含 l1.mode）
//        GET /api/l1/embeddings     → 向量库状态（只读、便宜）
//        GET /api/pending-triggers  → 三个层待消费的触发信号（只读探查）
//        GET /api/subagent-runs     → 正在跑的子代理（停止按钮的依据）
//        GET /api/l2/scene-pool/report · /merge-report → 场景池只读报告
//   ⑤ GET / → 302 到 viewers/index.html?port=（缺失回退 records-viewer.html）
//
// ── 两条会咬人的约定，改这个文件前先读 ──────────────────────────────────
//   A. **查询串被剥掉**：本文件的 url 取自 `req.url.split("?")[0]`，所以 GET 端点接不了参数。
//      需要参数的读操作一律用**路径段**（`/api/l2/scene-pool/report`），写操作一律 POST + JSON body。
//      别试图加 `?cmd=`，它会静默走到 404 分支。
//   B. **桥是单线程 + execFileSync 同步**：任何一次 CLI 调用期间整座桥都不响应请求。
//      因此慢动作（向量回填/重建、场景池报告）用长超时，并且页面上必须显示"运行中、勿重复点"；
//      这不是可以靠并发解决的问题，除非把执行改成子进程 + 轮询（本轮不做）。
//
// 用法：
//   node scripts/l1-admin/viewer-bridge.mjs [--port 5174] [--profile <dir>]
// 然后打开终端打印的 http://localhost:5174/viewers/index.html?port=5174
//
// 安全：仅绑定 127.0.0.1 本地回环；CORS 全放（本地工具）；勿暴露公网；用完关掉。
// 注意：本轮把写盘面从 2 个端点扩到 12 个（含写 live 画像与整库还原），CORS 全开的代价因此变大了
// —— 运行期间本机任何页面都能调这些端点。README 的"已知观察项"里记着这条。
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
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
const TRIGGER_LAYERS = new Set(["l1", "l2", "l3"]);
const L1_MODES = new Set(["code", "chat"]);
const EMBEDDING_OPS = new Set(["backfill", "rebuild"]);
/** profile **根**下允许经 `/api/profile-files` 读取的文件（固定白名单，无路径参数 ⇒ 无遍历面）。 */
const PROFILE_ROOT_FILES = ["MEMORY.md", "USER.md", "USER-temp.md"];
/**
 * 传给 CLI 的**文件名**白名单：只允许 basename（无路径分隔符）。CLI 自己还会再校验一次
 * （`l3-restore.mts` 要求 `user-backup-*.md`、`l2-archive.mts` 走 archive.ts 的同名检查），
 * 这里那道是为了不让明显非法的输入走到写盘逻辑里去。
 */
const SAFE_MD_NAME_RE = /^[^/\\]{1,200}\.md$/;
// 需要 --experimental-strip-types 才能 import 扩展里的 .ts 实现（Node ≥22.13）
const STRIP_TYPES = ["--experimental-strip-types"];
const DEFAULT_TIMEOUT_MS = 60000;
/** 慢动作超时（向量回填/重建：每批 10 条一次 embedding 请求）。 */
const LONG_TIMEOUT_MS = 30 * 60 * 1000;
/** 中等动作（场景池 report/merge-report：可能调 embedding）。 */
const MID_TIMEOUT_MS = 5 * 60 * 1000;
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

/**
 * 跑工具目录下的 CLI，捕获 stdout；失败时把 stderr/消息回给调用方。
 *
 * **失败路径也带回 stdout**：CLI 们是"成功/失败都出结构化 JSON + 用 exitCode 表达成败"的，
 * 若失败时只回 stderr 文本，调用方就拿不到那句人话（例如"提议稿比 live 旧…"）。
 */
function runCli(scriptArgs, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const stdout = execFileSync(process.execPath, [...STRIP_TYPES, ...scriptArgs, "--profile", PROFILE], {
      cwd: TOOL_DIR,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout), stderr: "" };
  } catch (e) {
    const stdout = e && e.stdout ? String(e.stdout) : "";
    const stderr = e && e.stderr ? String(e.stderr) : "";
    const detail = [stdout, stderr, e && e.message].filter(Boolean).join("\n");
    return { ok: false, stdout, stderr, error: String(detail || e).slice(0, 600) };
  }
}

/** 从 CLI 的 stdout 里取 JSON —— **从第一个 `{` 起解析**。
 *
 * 为什么不能整段 JSON.parse：CLI 可能先打日志行（例如 `autoBackup` 的「已自动备份：…」），
 * 整段解析会失败并把一次成功的写盘报成 500。取第一个 `{` 起的内容即可兼容前置噪声。
 * （反过来说：CLI 中途**不能**打带花括号的行，否则这里会解析到错的对象。约定写在 viewer-cli.mts 头部。） */
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

/** 把 CLI 的结构化输出透传给页面：成功 200 / 失败 500（成败由 CLI 自己的 success + exitCode 决定）。 */
function passthrough(res, scriptArgs, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const r = runCli(scriptArgs, timeoutMs);
  const parsed = parseCliJson(r.stdout);
  if (!parsed) {
    return sendJson(res, 500, {
      success: false,
      error: r.error || "CLI 未返回可解析的 JSON",
      raw: String(r.stdout || "").slice(0, 400),
    });
  }
  return sendJson(res, r.ok ? 200 : 500, parsed);
}

/**
 * 透传"说人话"的 CLI（`rollback.mjs` / `scene-pool.mjs` 都是 console.log 式输出，不是 JSON）。
 *
 * 别把它和 `passthrough` 混用：`parseCliJson` 会从第一个 `{` 起啃，而这两个脚本的输出里有的是
 * 分隔线、有的是表格，啃出来的要么是 null（报"未返回可解析的 JSON"，把一次成功说成失败），
 * 要么是半截对象。按文本带回去，页面自己渲染。
 */
function passthroughText(res, scriptArgs, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const r = runCli(scriptArgs, timeoutMs);
  if (!r.stdout.trim() && !r.ok) return sendJson(res, 500, { success: false, error: r.error || "CLI 无输出" });
  return sendJson(res, r.ok ? 200 : 500, { success: r.ok, text: r.stdout.trim(), stderr: r.stderr.trim().slice(0, 2000) });
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

/**
 * L1 库备份清单（`backups/l1-admin/{ts}-{tag}/`）。
 *
 * 只回"有多少个分片文件 + 总字节 + mtime"，**不数行**：行数要逐个读文件（备份 × 分片可达数百次 IO），
 * 而选择备份只需要看出"哪个新、多大"；完整性由 `rollback.mjs` 自己在还原前校验。
 */
function listL1Backups() {
  const dir = join(MEMORY_DB, "backups", "l1-admin");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    try {
      if (!statSync(full).isDirectory()) continue;
      const recDir = [join(full, "l1", "records"), join(full, "l1-records"), full].find((p) => existsSync(p));
      let shards = 0;
      let bytes = 0;
      if (recDir) {
        for (const f of readdirSync(recDir)) {
          if (!f.endsWith(".jsonl")) continue;
          try {
            const st = statSync(join(recDir, f));
            if (!st.isFile()) continue;
            shards++;
            bytes += st.size;
          } catch {
            /* 竞态忽略 */
          }
        }
      }
      out.push({ dir: name, shards, bytes, mtime: statSync(full).mtime.toISOString() });
    } catch {
      /* 读不了的跳过：宁可少一个备份，不让整次列举失败 */
    }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** L2 块归档 / 恢复的共用处理（两个端点的 body 形状只差一个默认 reason）。 */
async function l2Move(req, res, op) {
  const body = (await readBody(req)) || {};
  const filename = body.filename;
  if (typeof filename !== "string" || !SAFE_MD_NAME_RE.test(filename)) {
    return sendJson(res, 400, { success: false, error: "filename 必须是 .md 文件名（不含路径）" });
  }
  if (op === "archive" && !(typeof body.reason === "string" && body.reason.trim())) {
    return sendJson(res, 400, { success: false, error: "归档必须给 reason（这是归档唯一的审计凭据）" });
  }
  const cliArgs = ["l2-archive.mts", op, "--file", filename];
  if (typeof body.reason === "string" && body.reason.trim()) cliArgs.push("--reason", body.reason.trim().slice(0, 500));
  if (body.apply === true) cliArgs.push("--apply");
  return passthrough(res, cliArgs);
}

const server = createServer(async (req, res) => {  const cors = () => {
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

  // ══ 写盘：L1 ══════════════════════════════════════════════════════════

  // ── 删除（tombstone.mjs：备份 + 就地标记 + 校验；接受 N 个 id） ──
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

  // ── 任务状态（task-state.mts：写锁 + 就地改 taskState + taskStateChange 审计） ──
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

  // ── L1 纠错（l1-fix.mts → runFix：证据门槛 / 24h 防抖 / 高价值保护 / 正文内审计标注） ──
  // `apply:false`（默认）走 checkFixGates 预演；`force:true` 只解"高价值保护"那道闸。
  if (req.method === "POST" && url === "/api/l1/fix") {
    const body = (await readBody(req)) || {};
    const id = body.id;
    const action = body.action;
    if (typeof id !== "string" || !ID_RE.test(id)) return sendJson(res, 400, { success: false, error: "非法 id" });
    if (action !== "rewrite" && action !== "tombstone") return sendJson(res, 400, { success: false, error: "action 只能是 rewrite/tombstone" });
    const cliArgs = ["l1-fix.mts", id, "--action", action];
    if (typeof body.content === "string") cliArgs.push("--content", body.content);
    if (typeof body.evidence === "string") cliArgs.push("--evidence", body.evidence);
    if (typeof body.reason === "string") cliArgs.push("--reason", body.reason);
    if (typeof body.priority === "number" && Number.isFinite(body.priority)) cliArgs.push("--priority", String(Math.round(body.priority)));
    if (body.force === true) cliArgs.push("--force");
    if (body.apply === true) cliArgs.push("--apply");
    return passthrough(res, cliArgs);
  }

  // ── L1 整库还原（rollback.mjs：校验备份完整 → 当前库先自动备份 → 删掉当前 jsonl → 复制备份） ──
  // **不是单条撤销**，是整库替换。confirm 必须等于备份目录名（打字确认），否则一条都不动。
  if (req.method === "POST" && url === "/api/l1/rollback") {
    const body = (await readBody(req)) || {};
    const backup = body.backup;
    if (typeof backup !== "string" || !backup || backup.includes("/") || backup.includes("\\") || backup.startsWith(".")) {
      return sendJson(res, 400, { success: false, error: "backup 必须是 backups/l1-admin 下的目录名" });
    }
    const dir = join(MEMORY_DB, "backups", "l1-admin", backup);
    if (!existsSync(dir)) return sendJson(res, 400, { success: false, error: `备份不存在：${backup}` });
    if (body.apply === true && body.confirm !== backup) {
      return sendJson(res, 400, { success: false, error: `整库还原会替换当前全部 L1 记录，需要 confirm 等于备份目录名（${backup}）` });
    }
    const cliArgs = ["rollback.mjs", dir];
    if (body.apply === true) cliArgs.push("--apply");
    return passthroughText(res, cliArgs, LONG_TIMEOUT_MS);
  }

  // ── 向量库回填 / 重建（embedding.mts） ──
  // 长任务：桥在这里会**阻塞到跑完**（见文件头约定 B），所以页面要显示运行中状态。
  // 重建额外要求 confirm=REBUILD（它会先 clearAll 再全量重算，中途失败 = 库空）。
  if (req.method === "POST" && url === "/api/l1/embedding") {
    const body = (await readBody(req)) || {};
    const op = body.op;
    if (!EMBEDDING_OPS.has(op)) return sendJson(res, 400, { success: false, error: "op 只能是 backfill/rebuild" });
    if (op === "rebuild" && body.apply === true && body.confirm !== "REBUILD") {
      return sendJson(res, 400, { success: false, error: "重建会先清空向量库再全量重算，需要 confirm=REBUILD" });
    }
    const cliArgs = ["embedding.mts", op];
    if (body.apply === true) {
      cliArgs.push("--apply");
      if (op === "rebuild") cliArgs.push("--confirm", "REBUILD");
    }
    return passthrough(res, cliArgs, LONG_TIMEOUT_MS);
  }

  // ── L1 提取模式（l1-mode.mts → saveL1Mode；配置节是整节替换，必须走它以免冲掉同节别的字段） ──
  if (req.method === "POST" && url === "/api/l1/mode") {
    const body = (await readBody(req)) || {};
    if (!L1_MODES.has(body.mode)) return sendJson(res, 400, { success: false, error: "mode 只能是 code/chat" });
    return passthrough(res, ["l1-mode.mts", "--set", body.mode]);
  }

  // ── 请求某层入队（trigger.mts → 落盘信号；**不是立即执行**，见该脚本头注释） ──
  if (req.method === "POST" && url === "/api/trigger") {
    const body = (await readBody(req)) || {};
    if (!TRIGGER_LAYERS.has(body.layer)) return sendJson(res, 400, { success: false, error: "layer 只能是 l1/l2/l3" });
    const cliArgs = ["trigger.mts", "--layer", body.layer, "--by", "viewer"];
    if (typeof body.reason === "string" && body.reason.trim()) cliArgs.push("--reason", body.reason.trim().slice(0, 200));
    return passthrough(res, cliArgs);
  }

  // ── 停掉某层子代理（subagent-stop.mts → stopSubagent：先拦 → 杀进程树 → 杀后修复） ──
  // 不可逆（本批未提交 ⇒ 游标不推进，下一轮重做），所以界面上要有确认。CLI 没有 dry-run：
  // 要么停，要么报"没有在跑的子代理"（success:true + stopped:false）。
  if (req.method === "POST" && url === "/api/subagent/stop") {
    const body = (await readBody(req)) || {};
    if (!TRIGGER_LAYERS.has(body.layer)) return sendJson(res, 400, { success: false, error: "layer 只能是 l1/l2/l3" });
    const cliArgs = ["subagent-stop.mts", "--layer", body.layer];
    if (typeof body.reason === "string" && body.reason.trim()) cliArgs.push("--reason", body.reason.trim().slice(0, 200));
    if (typeof body.job === "number" && Number.isFinite(body.job) && body.job > 0) cliArgs.push("--job", String(Math.round(body.job)));
    return passthrough(res, cliArgs);
  }

  // ══ 写盘：L2 ══════════════════════════════════════════════════════════

  // ── 场景块归档 / 恢复（l2-archive.mts：**L2 运行级锁** + 自愈 + 搬块 + 重建索引） ──
  if (req.method === "POST" && url === "/api/l2/archive") {
    return l2Move(req, res, "archive");
  }
  if (req.method === "POST" && url === "/api/l2/restore") {
    return l2Move(req, res, "restore");
  }

  // ── 场景池播种（scene-pool.mjs seed --file <提案>）：把"旧名→稳定标签"的映射写进 l1/scenes.json ──
  // 提案由页面在 body 里给（`{scenes:[{name,aliases,note?}]}`），桥写成 memoryDB/tmp 下的临时文件再转发
  // —— CLI 只接受文件路径，而页面写不了盘。
  if (req.method === "POST" && url === "/api/l2/scene-pool/seed") {
    const body = (await readBody(req)) || {};
    const scenes = Array.isArray(body.scenes) ? body.scenes : null;
    if (!scenes || scenes.length === 0) return sendJson(res, 400, { success: false, error: "scenes 数组必填（[{name, aliases:[]}]）" });
    const badScene = scenes.find((s) => !s || typeof s.name !== "string" || !s.name.trim());
    if (badScene) return sendJson(res, 400, { success: false, error: "每个场景都需要非空 name" });
    const tmpDir = join(MEMORY_DB, "tmp");
    try {
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      const proposalPath = join(tmpDir, `viewer-scene-proposal-${Date.now()}.json`);
      writeFileSync(proposalPath, JSON.stringify({ scenes }, null, 2), "utf-8");
      const cliArgs = ["scene-pool.mjs", "seed", "--file", proposalPath];
      if (body.apply === true) cliArgs.push("--apply");
      return passthroughText(res, cliArgs, MID_TIMEOUT_MS);
    } catch (e) {
      return sendJson(res, 500, { success: false, error: `写临时提案失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // ══ 写盘：L3 ══════════════════════════════════════════════════════════

  // ── 提议稿条目增删改（l3-edit.mts → applyL3Edit，与 l3_edit 工具同一段实现；写 USER-temp.md） ──
  if (req.method === "POST" && url === "/api/l3/edit") {
    const body = (await readBody(req)) || {};
    const action = body.action;
    if (action !== "add" && action !== "update" && action !== "delete") {
      return sendJson(res, 400, { success: false, error: "action 只能是 add/update/delete" });
    }
    // 条目正文与定位片段都是**单行**（normalizeEntryText 会拒换行/§）；这里只挡明显超长的输入。
    if (typeof body.content === "string" && body.content.length > 4000) {
      return sendJson(res, 400, { success: false, error: "content 过长（>4000 字符）" });
    }
    const cliArgs = ["l3-edit.mts", action];
    if (typeof body.content === "string") cliArgs.push("--content", body.content);
    if (typeof body.target === "string") cliArgs.push("--target", body.target);
    if (body.apply === true) cliArgs.push("--apply");
    return passthrough(res, cliArgs);
  }

  // ── 提议稿还原（l3-restore.mts：还原到 USER-temp.md，写前把当前 temp 另存备份） ──
  // 目标恒为 temp 而非 live：备份文件名不记"当时捕的是 temp 还是 live"，统一落到 L3 唯一的写目标，
  // 要上 live 再走一次并入（语义写在 l3-viewer 的还原面板上）。
  if (req.method === "POST" && url === "/api/l3/restore") {
    const body = (await readBody(req)) || {};
    const file = body.file;
    if (typeof file !== "string" || !/^user-backup-[0-9A-Za-z_.-]+\.md$/.test(file)) {
      return sendJson(res, 400, { success: false, error: "file 必须是 user-backup-<时间戳>.md" });
    }
    if (body.apply === true && body.confirm !== file) {
      return sendJson(res, 400, { success: false, error: `还原会覆盖当前提议稿，需要 confirm 等于备份文件名（${file}）` });
    }
    const cliArgs = ["l3-restore.mts", "--file", file];
    if (body.allowEmpty === true) cliArgs.push("--allow-empty");
    if (body.apply === true) {
      cliArgs.push("--apply", "--confirm", file);
    }
    return passthrough(res, cliArgs);
  }

  // ── 并入 live USER.md（l3-merge.mts → mergeTempIntoLive）：全仓库唯一写 live 画像的路径 ──
  // 三道安全闸（陈旧 / 过半删除 / 清空）由实现裁决，页面把 `allow*` 透传给用户显式放行的情形。
  if (req.method === "POST" && url === "/api/l3/merge") {
    const body = (await readBody(req)) || {};
    if (body.apply === true && body.confirm !== "MERGE") {
      return sendJson(res, 400, { success: false, error: "并入会覆盖 live USER.md，需要 confirm=MERGE" });
    }
    const cliArgs = ["l3-merge.mts"];
    if (body.allowStale === true) cliArgs.push("--allow-stale");
    if (body.allowMassRemoval === true) cliArgs.push("--allow-mass-removal");
    if (body.allowEmpty === true) cliArgs.push("--allow-empty");
    if (body.apply === true) cliArgs.push("--apply", "--confirm", "MERGE");
    return passthrough(res, cliArgs);
  }

  // ══ 读 ════════════════════════════════════════════════════════════════

  if (req.method === "GET" && url === "/api/health") {
    return sendJson(res, 200, { ok: true, profile: PROFILE });
  }

  // ── 诊断：源码版本 vs 已部署版本（漂移检测） ──
  // 算法不在这里重算：转发给 viewer-status.mts，它 import 与部署同一份 scanViewerSource。
  if (req.method === "GET" && url === "/api/viewer-status") {
    return passthrough(res, ["viewer-status.mts"], 30000);
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

  // ── 列目录：L1 库备份（还原面板的候选；此前只有写者、没有列举者） ──
  if (req.method === "GET" && url === "/api/l1/backups") {
    const backups = listL1Backups();
    return sendJson(res, 200, { backups, count: backups.length });
  }

  // ── 活跃会话日（权威来源；侧车会滞后，见 active-days.mts 头部实测记录） ──
  if (req.method === "GET" && url === "/api/l1/active-days") {
    return passthrough(res, ["active-days.mts"], 30000);
  }

  // ── 向量库状态（只读、便宜；回填/重建走 POST /api/l1/embedding） ──
  if (req.method === "GET" && url === "/api/l1/embeddings") {
    return passthrough(res, ["embedding.mts", "status"], DEFAULT_TIMEOUT_MS);
  }

  // ── 三层待消费的触发信号（只读探查，**不消费** —— 展示不该有副作用） ──
  if (req.method === "GET" && url === "/api/pending-triggers") {
    return passthrough(res, ["trigger.mts", "--status"], 30000);
  }

  // ── 正在跑的子代理（停止按钮的依据：没有运行记录就不该显示"停止"） ──
  if (req.method === "GET" && url === "/api/subagent-runs") {
    return passthrough(res, ["subagent-stop.mts", "--list"], 30000);
  }

  // ── 列目录：L2 场景块（live 与 archive） ──
  if (req.method === "GET" && url === "/api/l2/blocks") {
    return sendJson(res, 200, {
      live: listDir(join("l2", "scene-blocks"), [".md"]),
      archive: listDir(join("l2", "archive"), [".md"]),
    });
  }

  // ── 场景池只读报告（scene-pool.mjs 的 report / merge-report；cluster/seed 是写或慢动作） ──
  // 路径段传参而非查询串 —— 见文件头约定 A。输出是文本报告 → 走 passthroughText（别拿 JSON 去啃）。
  if (req.method === "GET" && (url === "/api/l2/scene-pool/report" || url === "/api/l2/scene-pool/merge-report")) {
    const cmd = url.endsWith("merge-report") ? "merge-report" : "report";
    return passthroughText(res, ["scene-pool.mjs", cmd], MID_TIMEOUT_MS);
  }

  // ── 阈值与配置节（只回查看器要展示的数字；不暴露 config/ 整份文件，见 viewer-limits.mts 头部说明） ──
  if (req.method === "GET" && url === "/api/limits") {
    return passthrough(res, ["viewer-limits.mts"], 30000);
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
  console.log(`  写盘 L1：POST /api/tombstone · /api/task-state · /api/l1/fix · /api/l1/rollback · /api/l1/embedding · /api/l1/mode`);
  console.log(`  写盘 L2/L3：POST /api/l2/archive · /api/l2/restore · /api/l2/scene-pool/seed · /api/l3/edit · /api/l3/restore · /api/l3/merge`);
  console.log(`  运维：POST /api/trigger（请求入队，需 pi 会话消费）· POST /api/subagent/stop（停子代理）`);
  console.log(`  读：GET /api/l1/shards · /api/l1/backups · /api/l1/embeddings · /api/l2/blocks · /api/l2/scene-pool/report`);
  console.log(`      /api/l3/backups · /api/profile-files · /api/limits · /api/pending-triggers · /api/subagent-runs · /api/viewer-status`);
  console.log(`  注意：向量回填/重建期间本进程会阻塞（execFileSync），页面显示"运行中"是正常的`);
  console.log(`  关停：Ctrl+C`);
});
