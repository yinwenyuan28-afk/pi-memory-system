/**
 * 记忆系统数据路径中央常量
 *
 * 背景（2026-08-17 首次收束）：L0-L3 运行数据原本散落在 {profilePath} 根目录，
 * 与注入画像（MEMORY.md/USER.md）、sub-memories/、skills/ 等混杂，统一收进
 * {profilePath}/memoryDB/ 一处定义、各模块引用。
 *
 * 2026-09-14 二次重整（方案 A · 分层重排）：memoryDB 内部从「扁平混排」改为按层分组——
 * 游标与所属层同处、散件（stats / viewer / backup）各自归目录。目标布局：
 *
 *   memoryDB/
 *   ├── config/                              （统一配置中心，见 config/app-config）
 *   ├── l0/{conversations/, cursor.json}
 *   ├── l1/{records/, cursor.json, scenes.json, anchor-log.jsonl, hit-stats.sqlite, hit-stats.json}
 *   ├── l2/{scene-blocks/, cursor.json, index/{scene_index.json, scene_members.json}}
 *   ├── l3/{cursor.json}
 *   ├── skill/{feed/, cursor.json}
 *   ├── search/vectors/                      （l1-vectors.sqlite）
 *   ├── pipeline/jobs.sqlite
 *   ├── state/failure-state.json
 *   ├── viewers/                             （records-viewer.html / vue-viewer/）
 *   └── backups/{l1-admin/, user-backups/}
 *
 * 边界（不归 memoryDB）：
 *   - MEMORY.md / USER.md：注入画像，保持 profile 根目录
 *   - state/review-cursor.json：review 模块独立游标（见 REVIEW_CURSOR_FILE，不经 MEMORY_DB_DIR）
 *   - {profile}/deprecated/：已停用的旧系统文件（memory-index.json / memory-save-log.jsonl /
 *     workflows.db* / 记忆保存信号.md / 记忆分类框架.md）—— 2026-09-14 profile 根整理，见其 README.md
 *
 * 用法：所有数据文件路径 = join(profilePath, MEMORY_DB_DIR, <常量>)
 *       —— 常量值可为**多段相对路径**，`join` 会自动拼斜杠，调用点无需感知层级。
 */
import { join } from "node:path";

/** 统一数据目录名（{profilePath}/memoryDB）。 */
export const MEMORY_DB_DIR = "memoryDB";

// ── L0 对话分片 ─────────────────────────────────────────────
/** L0 对话分片目录（{memoryDB}/l0/conversations）。 */
export const L0_CONVERSATIONS_DIR = join("l0", "conversations");
/** L0 游标文件（{memoryDB}/l0/cursor.json）。 */
export const L0_CURSOR_FILE = join("l0", "cursor.json");

// ── L1 原子记忆 ─────────────────────────────────────────────
/** L1 记忆输出目录（{memoryDB}/l1/records）。 */
export const L1_RECORDS_DIR = join("l1", "records");
/** L1 游标文件（{memoryDB}/l1/cursor.json）。 */
export const L1_CURSOR_FILE = join("l1", "cursor.json");
/**
 * 【已退役 2026-09-15】L1 情境锚点注入日志（{memoryDB}/l1/anchor-log.jsonl）。
 *
 * 场景池上线后不再写入（度量改为按 `scene_id` 从记录派生，不需要这份分母）。常量保留是因为
 * **文件仍在磁盘上**（5 条历史注入记录 = 旧复用率基线的证据）；不要在代码里再引用它。
 */
export const L1_ANCHOR_LOG_FILE = join("l1", "anchor-log.jsonl");
/**
 * L1 工作场景池（{memoryDB}/l1/scenes.json）。
 *
 * **场景归属的唯一真源**——记录里的 `scene_name` 只是落盘当时的历史快照。条目含稳定 id、
 * canonical 名字（`{项目}｜{议题}` 稳定标签）、cwd 集合、别名与合并指针。
 * 写入者只有 `l1_commit`（写锁内），`buildL1Task` 只读注入。
 */
export const L1_SCENES_FILE = join("l1", "scenes.json");
/** L1 命中统计 sqlite（{memoryDB}/l1/hit-stats.sqlite）。 */
export const L1_HIT_STATS_SQLITE = join("l1", "hit-stats.sqlite");
/** L1 命中统计 JSON 侧车（{memoryDB}/l1/hit-stats.json，供 records-viewer.html fetch）。 */
export const L1_HIT_STATS_JSON = join("l1", "hit-stats.json");
/**
 * L1 价值校验的丢弃留痕（{memoryDB}/l1/value-check-log.jsonl）。
 *
 * 校验器判 `drop` 的记录**不写进库**，所以必须在别处留痕：否则"被扔掉的东西"完全不可见 ——
 * 既无法审计它是不是误杀，也无法度量它到底拦下了什么。一行一条（append-only）。
 */
export const L1_VALUE_CHECK_LOG = join("l1", "value-check-log.jsonl");

// ── L2 场景 ────────────────────────────────────────────────
/** L2 场景块目录（{memoryDB}/l2/scene-blocks）。 */
export const L2_SCENE_DIR = join("l2", "scene-blocks");
/** L2 游标文件（{memoryDB}/l2/cursor.json）。 */
export const L2_CURSOR_FILE = join("l2", "cursor.json");
/** L2 索引目录（{memoryDB}/l2/index）。 */
export const L2_INDEX_DIR = join("l2", "index");
/** L2 场景索引（{memoryDB}/l2/index/scene_index.json；由 syncSceneIndex() 全量重建）。 */
export const L2_SCENE_INDEX_PATH = join("l2", "index", "scene_index.json");
/**
 * L2 场景块 → 成员 L1 记录 id 的 sidecar（{memoryDB}/l2/index/scene_members.json）。
 *
 * 为什么不直接写进 `scene_index.json`：该索引由 `syncSceneIndex()` 在每次提交后**从块文件全量重建**，
 * 任何只存在于索引里的字段都会在下次重建时丢失。所以成员清单需要独立的持久化载体，由
 * `syncSceneIndex()` 读取并并进索引条目 —— 对外表现仍是"成员的机读入口在索引里"，块文件保持轻量。
 */
export const L2_SCENE_MEMBERS_PATH = join("l2", "index", "scene_members.json");
/**
 * L2 归档目录（{memoryDB}/l2/archive）—— 场景块满了以后把冷块搬到这里（2026-09-27）。
 *
 * 为什么与 `scene-blocks/` **平级**而不是它的子目录：块数统计走「目录列举 + 只认顶层 `.md`」
 * （`countSceneBlocks`、`l2_commit` 的上限预检、`syncSceneIndex` 三处同口径），所以搬出去的块
 * **天然不占名额**，索引重建零改动。平级而非嵌套，是为了人工查看与层级都好读。
 */
export const L2_ARCHIVE_DIR = join("l2", "archive");
/**
 * L2 归档块的成员 sidecar（{memoryDB}/l2/archive/scene_members.json）—— 与 live 侧车同构。
 *
 * **权威、不可重建**：索引是派生物，但"哪些 L1 记录属于这个已归档的块"只在这里（正文里的 id token 只作兜底）。
 * `l1/fix-tool` 的高价值判定靠反查成员清单（live 索引 + 本文件），丢了会让归档块名下的记录
 * **静默失去保护**（可被 `l1-fix` 直接改写/墓碑）。
 */
export const L2_ARCHIVE_MEMBERS_PATH = join("l2", "archive", "scene_members.json");
/**
 * L2 归档事件账（{memoryDB}/l2/archive/ledger.jsonl，append-only）。
 *
 * 一行一条 `{op, filename, at, reason, by, ...}`。**不重建**：记的是"谁在什么时候为什么搬的"，
 * 这是归档区别于 `delete` 的核心（可追溯）。文件丢了可由**目录扫描**补出 `ledger-missing`
 * 条目（存在性真源永远是目录，见 `listArchivedBlocks`）。
 */
export const L2_ARCHIVE_LEDGER_PATH = join("l2", "archive", "ledger.jsonl");


// ── L3 画像 ────────────────────────────────────────────────
/** L3 游标文件（{memoryDB}/l3/cursor.json）。 */
export const L3_CURSOR_FILE = join("l3", "cursor.json");
/**
 * L3 待处理触发信号（{memoryDB}/l3/pending-trigger.json）。
 *
 * 存在理由：`l2_commit` 只在 **l2-scene-organizer 子代理进程**里执行（实测 46/46 次），
 * 而那个进程里 `l3Controls` 恒为 undefined（`index.ts` 的 `PI_SUBAGENT_CHILD` 早退在
 * `setupL3Persona` 之前）—— 于是 `onCommitted` 回调不是"通道"，是静默丢弃。
 * 子代理把意图写成这个文件，主进程在 `agent_settled` 读取并消费（读后即删）。
 * 与 `l2/cursor.json` 同款跨进程手法（子代理进程本来就直写游标文件）。
 *
 * 注（2026-09-19）：L3 已并入串行执行器（`pipeline/jobs.sqlite` 的 `type='l3'`），
 * 原先的 `l3/run.lock` 文件锁已退役 —— 队列的 running 状态就是那个跨进程真闸。
 */
export const L3_PENDING_TRIGGER_FILE = join("l3", "pending-trigger.json");

// ── skill-feed ─────────────────────────────────────────────
/** skill-feed 原料输出目录（{memoryDB}/skill/feed，按 session 一文件）。 */
export const SKILL_FEED_DIR = join("skill", "feed");
/** skill-feed 游标文件（{memoryDB}/skill/cursor.json，独立于 L0）。 */
export const SKILL_FEED_CURSOR_FILE = join("skill", "cursor.json");

// ── 检索 / 流水线 / 状态 ────────────────────────────────────
/** 向量库目录（{memoryDB}/search/vectors，内含 l1-vectors.sqlite）。 */
export const VECTORS_DIR = join("search", "vectors");
/** L1/L2 流水线 job 队列（{memoryDB}/pipeline/jobs.sqlite）。 */
export const PIPELINE_JOBS_FILE = join("pipeline", "jobs.sqlite");
/** 各层失败状态（{memoryDB}/state/failure-state.json）。 */
export const FAILURE_STATE_FILE = join("state", "failure-state.json");
/**
 * 子代理停止请求标记的前缀（`{memoryDB}/state/stop-request-<layer>.json`，2026-09-26）。
 *
 * 用途：硬上限要停掉子代理时，主进程先落这个标记，该层的写工具在**入口**检查它 ——
 * Windows 上进程没有可捕获的优雅信号（SIGTERM 即 TerminateProcess），
 * 所以"让它体面停下"只能靠这种协作式停止（详见 `memory/pipeline/stop-request.ts`）。
 */
export const STOP_REQUEST_FILE_PREFIX = join("state", "stop-request-");
/**
 * 子代理**运行级锁**目录前缀（`{memoryDB}/state/run-lock-<layer>.lock/`，2026-09-26）。
 *
 * 用途：让"谁在写这一层"由写者自己持有（`mkdir` 占位 + `owner.json`），
 * 从而不再依赖监督者判断"子代理何时算结束"（详见 `memory/pipeline/run-lock.ts`）。
 */
export const RUN_LOCK_FILE_PREFIX = join("state", "run-lock-");

// ── 运行日志与跨进程通知 ────────────────────────────────────
/**
 * 运行日志目录（{memoryDB}/logs）。
 *
 * 四通道之一「文件日志」的落点：`logEvent()` 按 scope 追加 `{scope}.log`（单文件 5MB 轮转一代）。
 * 高频观测（召回观测行、L3 未触发原因、编排决策）只进这里，不打终端也不进聊天区。
 */
export const MEMORY_LOGS_DIR = "logs";
/**
 * 跨进程通知队列（{memoryDB}/logs/notices.jsonl）。
 *
 * 为什么需要：卡片通道用的是 `pi.appendEntry()`，而 L1/L2/L3 子代理跑在**独立进程**
 * （pi-subagents spawn + `--mode json`），那里的 appendEntry 只写进子代理自己的 session，
 * 用户永远看不到。所以子代理把卡片载荷落进本文件，主进程用 rename 原子取走后渲染成
 * 真正的聊天区卡片（见 `util/notice.ts` 的 `noticeCard` / `drainNoticeCards`）。
 */
export const NOTICE_QUEUE_FILE = join("logs", "notices.jsonl");

// ── viewer / 备份 ──────────────────────────────────────────
/** 查看器目录（{memoryDB}/viewers：records-viewer.html / vue-viewer/）。 */
export const VIEWER_DIR = "viewers";
/** 备份目录（{memoryDB}/backups：l1-admin/ 与 user-backups/）。 */
export const BACKUP_DIR = "backups";
/** 用户画像备份目录（{memoryDB}/backups/user-backups：L3 写 USER.md 前的 `user-backup-*.md` 快照）。 */
export const USER_BACKUPS_DIR = join("backups", "user-backups");

// ── profile 级运行态（**不经 MEMORY_DB_DIR**）────────────────────
/**
 * 审查游标（{profile}/state/review-cursor.json）。
 *
 * 与上面所有常量不同：**不放进 memoryDB/** —— 它是 review 模块（memory-reviewer /
 * skill-reviewer）的独立游标，不属于 L0–L3 管线产物。2026-09-14 由 profile 根整理至此
 * （原先散在 profile 根，与 MEMORY.md/USER.md 混放）。
 * 用法：`join(profilePath, REVIEW_CURSOR_FILE)`（**不要**再拼 MEMORY_DB_DIR）。
 */
export const REVIEW_CURSOR_FILE = join("state", "review-cursor.json");
