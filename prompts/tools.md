<!-- 工具 description 单源（分节加载：registry key = tools#工具名）。
     启动静态类：md 缺失时 registry 抛错（无运行时兜底——缺文件=仓库损坏）。
     内容由迁移前 .ts 字面量程序化提取，基线见 .golden/tools.json；改这里即改工具说明。 -->

## load_memory_rules

Load the L1 record contract (what to record, type enum, priority, call shape) into context. Call this when you decide to record something, BEFORE calling l1_commit. Params: mode="once" (default, cleared after one l1_commit) or mode="always" (permanent for this session).

## skill_manage

Manage skills (create, edit, delete, list). Skills are your procedural memory — reusable approaches for recurring task types. General memory (MEMORY.md / USER.md) is broad and declarative; skills are narrow and actionable.

Create when: complex task succeeded (5+ calls), errors overcome, user-corrected approach worked, non-trivial workflow discovered.
Update when: instructions stale/wrong, missing steps or pitfalls found during use. If you used a skill and hit issues not covered by it, patch it immediately.

New skills go to profiles/<active>/skills/<category>/<name>/SKILL.md. Existing skills can be modified wherever they live.

Pinned skills are protected from deletion only — edit and write_file still work. Unpin first to delete. Bundled skills (system-level) cannot be modified at all.

Good skills include: concrete trigger conditions (When to Use), numbered steps with exact commands, a pitfalls section, and verification steps. Use skill_view() to see format examples.

## skill_view

View the content of a skill's SKILL.md or support files. Use this to inspect a skill before deciding whether to update it.

## l1_commit

Commit L1 memory records. Two modes via 'source':
  - 'subagent' (default): the l1-extractor subagent after extraction/dedup; requires 'records' + 'cursor' (advances the L1 cursor = L0 incremental watermark). Scene attribution goes through the scene pool: put `scene_id` (picked from the ScenePool block in the task message) on records that continue an existing scene, or `new_scene_name` + `new_scene_reason` on records that start a new one. Server-side replaces `scene_name` with the pool's canonical name, registers new scenes, and strips the two intermediate fields before writing.
  - 'main-agent': the main agent proactively records a durable fact mid-session; requires only 'records' (each item needs just {content, type, priority?}). id / timestamps / sessionKey / sessionId / cwd are filled server-side; the L1 cursor is NOT advanced and L2 is NOT enqueued. `scene_name` is optional: if omitted, the record is attributed to the most recent scene of the same cwd (fallback `main-agent-live`); if given, it is matched against the pool by name/alias but never registered as a new scene.

## list_l1_scenes

List the L1 scene pool — the canonical set of work scenes — so a record can be attributed to an existing scene **by id** instead of an invented name. Call this BEFORE `l1_commit` when recording: pick the `scene_id` whose topic matches the fact you are about to write. If nothing fits, omit the id and pass a stable `scene_name` of the form `{project}｜{topic}` (never encode what you are currently doing into it). Read-only. Returns the same window/limit the extractor sees: `{scenes: [{id, name, cwd, lastUsedAt, useCount}], returned, note}`. Entries absent from the list are either merged away or unused for over 60 days. Omitting both the id and the name is allowed but marks the record as unclassified.

## l1_fix

Fix or remove an L1 memory record found to be wrong (agent-initiated correction). Executes the same in-place semantics as the l1-admin CLI (rewrite = new id + old row tombstoned in place; tombstone = mark deleted). Guards: evidence (>=20 chars, required), audit annotation auto-appended, 24h debounce per record, high-value protection (hits>=5 or referenced by L2 scene members -> rejected, use '/my-memory:l1:fix --force'). Params: recordId (required), action ('rewrite'|'tombstone'), newContent (required for rewrite), evidence (required), reason (optional), priority (optional 0-100 reassessment for rewrite).

## read_l0_increment

Read L0 conversation increment after a cursor in one call (replaces piecewise read). Called by the l1-extractor subagent. Params: l0Files (comma-separated absolute paths of L0 shards), cursor (lastRecordedAt ISO string, empty for full scan). Returns { messages (new messages with cwd, time ascending), background (first 5 as context only, never extract from them), nextCursor, truncated }.

## read_l1_increment

Read L1 records newer than the L2 cursor in one call (replaces being pointed to a .l2-staging file). Called by the l2-scene-organizer subagent. Params: l1Dir (absolute path of L1 records directory, from RecordsDir in task message), cursor (optional L2 lastRecordId, default read from l2/cursor.json), maxRecords (optional, default 50, hard cap 200). Returns { records (new L1 records with key fields, deleted=true entries preserved for history), nextCursor (last id of returned), totalNew (unfiltered count), returned (this call's count), truncated }.

## l2_commit

Commit scene block writes and advance the L2 cursor. Called by the l2-scene-organizer subagent. Params: sceneWrites (array of {action: create|update|merge|delete|consolidate, filename, sources, meta: {created,updated,summary,heat}, content, members}), cursor (lastRecordId string), personaSignal (optional boolean), personaReason (optional string). CONSOLIDATE is the preferred action for merging blocks: pass sources=[blockA.md,blockB.md,...] plus the merged content — the host backs up the sources, verifies no entry was dropped (rejects the batch when the target body is drastically shorter than the sources, or when an explicit members list misses source members), then writes the target and deletes the sources atomically. NOTE: the total scene-block count has a hard cap (config l2.maxScenes, passed as the MaxScenes line in the task message). If this batch would push the count above the cap, the whole batch is REJECTED and you must first consolidate same-project blocks to free slots, then retry.

## l3_edit

Change exactly ONE rule line in USER.md — the user profile block injected into every turn. One call = one entry: `add` a new rule, `update` an existing one, or `delete` one. The whole file is yours to manage, but NEVER rewrite it wholesale: `content` must be a single line, and the host rejects any text containing a newline, `§`, or an HTML comment. Make one call per rule you want to change, as many calls as needed. Params: action ('add'|'update'|'delete', required); content (for add/update: the single rule text); target (for update/delete: a distinctive fragment of the existing entry — the host resolves it against the file and REFUSES the call when 0 or more than 1 entry matches, returning the candidate list so you can pass a longer fragment). After every call the host re-checks the whole-file budget (the CharLimit line in the task message) and rejects a change that would push the file over it — free space by deleting or compressing other entries, then retry. Returns {success, action, position, entryCount, usage}.

## l3_commit

Finish an L3 persona update and advance the L3 cursor. Called by l3-persona-generator as the LAST action of every run — including runs where you decided nothing needed changing (the cursor must still advance, otherwise the same scenes are re-processed next turn). Params: cursor (the newest `updated` ISO timestamp among the scenes you processed). The persona text is NOT passed here: every rule change goes through l3_edit, one entry per call.

## recall_l1_records

Search your L1 atomic memories (durable facts, work methods, tasks, and artifacts extracted from past sessions) by semantic similarity. Use when: (a) no <l1-records> block is present this turn (it is inserted only once recall is ready; a turn that finishes in a single LLM call never gets it), or the block does not cover what you need; (b) the user references something from earlier sessions — past decisions, project conventions, preferences, or previously fixed issues; (c) you need more candidates than the injected top-3. Returns top-K records as {recordId, score, content, type, priority, scene_name, createdAt}. Call limit: max 3 times per turn total. If 3 attempts return nothing relevant, the memory is not stored — answer from existing context. Independent of the legacy memory system (jieba inverted index / sub-memories).

## clear_invalid_l1_records

Mark L1 atomic memories as INVALID (agent judged them irrelevant after recall). For each recordId, increments invalid_hits and recomputes effective_hits = hits - invalid_hits in the L1 hit-stats DB (auto-rewrites l1/hit-stats.json consumed by records-viewer). Only records that were actually recalled (hits > 0) are counted; never-recalled ids are skipped. This is a feedback signal ONLY — the record is NOT deleted, its quality drops and recall may still return it. Call this when you recalled a memory via recall_l1_records but found it useless for the current task.

## embed_and_search

Embed queryText into vector, then cosine search top-K similar L1 records. Returns record_id + content + type + priority + score. Used by l1-extractor to find candidates for dedup (replaces 30-day full read).

## read_skill_feed_increment

Read skill-feed (5-role sanitized conversation with tool_call/tool_result) increment after a cursor in one call. Called by the skill-reviewer subagent. Params: feedFiles (comma-separated absolute paths of skill-feed files), cursor (lastRecordedAt ISO string, empty for full scan). Returns { messages (new entries with role/content/tool_name/tool_call_id/is_error, time ascending), background (first 5 as context only, never extract from them), nextCursor, truncated }.
