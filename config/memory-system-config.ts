/**
 * model 配置读取（2026-09-02 收束到 application-propertis.json 的 model 节）。
 *
 * 定位：本扩展模型配置的统一读入口。2026-09-02 起迁移：
 * - 新位置：{profile}/memoryDB/config/application-propertis.json 的 `model` 节：
 *     { "model": { "llm": {...}, "embedding": {...} } }
 *   含敏感字段（embedding.apiKey），用户拍板并入统一配置中心（profile 级隔离）。
 * - 兜底：旧 {profile}/memoryDB/config/memory-system-model.json
 *   （数组 [{type:"llm",...},{type:"embedding",...}] 或行式 JSONL），迁移期兼容。
 *
 * 消费者：model-config.ts（type=llm）、embedding/config.ts（type=embedding）。
 * 子代理进程独立读（不通过 globalThis 桥接），各进程自行解析。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DB_DIR } from "../memory/paths.js";
import { loadAppProps } from "./app-config.js";

/** 配置文件相对 profile 的目录（旧格式遗留路径）。 */
const LEGACY_CONFIG_DIR = join("memoryDB", "config");
/** 旧配置文件名（已废弃，仅读取兜底兼容）。 */
export const MEMORY_SYSTEM_MODEL_FILE = "memory-system-model.json";

/** 单条条目：type 区分用途，其余字段按条目类型约定。 */
export type MemorySystemModelEntry = Record<string, unknown>;

/** model 节结构（application-propertis.json）。 */
interface ModelSection {
  llm?: Record<string, unknown>;
  embedding?: Record<string, unknown>;
}

/**
 * 旧配置文件绝对路径。
 *
 * @param profilePath profile 根目录（如 ~/.pi/agent/profiles/default）
 */
export function getLegacyModelConfigPath(profilePath: string): string {
  return join(profilePath, LEGACY_CONFIG_DIR, MEMORY_SYSTEM_MODEL_FILE);
}

/**
 * 读取全部条目（旧 API：返回数组式条目，供兼容场景使用）。
 *
 * 优先：application-propertis.json 的 model 节 → 展开为 [{type:"llm",...},{type:"embedding",...}]。
 * 兜底：旧 memory-system-model.json（标准数组 → 行式 JSONL）。
 */
export function readModelEntries(profilePath: string): MemorySystemModelEntry[] {
  const appProps = loadAppProps(profilePath);
  const section = appProps?.model as ModelSection | undefined;
  if (section && typeof section === "object") {
    const entries: MemorySystemModelEntry[] = [];
    if (section.llm && typeof section.llm === "object") {
      entries.push({ type: "llm", ...section.llm });
    }
    if (section.embedding && typeof section.embedding === "object") {
      entries.push({ type: "embedding", ...section.embedding });
    }
    if (entries.length > 0) return entries;
  }
  return readLegacyModelEntries(profilePath);
}

/**
 * 按 type 取条目（type: "llm" / "embedding"）。
 *
 * 优先读 model 节下的同名子键；节缺失/无该子键时兜底旧文件。
 *
 * @param type 条目类型（"llm" / "embedding" 等）
 * @returns 条目对象；无匹配返回 null
 */
export function readModelEntry(profilePath: string, type: string): MemorySystemModelEntry | null {
  const appProps = loadAppProps(profilePath);
  const section = appProps?.model as ModelSection | undefined;
  if (section && typeof section === "object") {
    const sub = section[type as keyof ModelSection];
    if (sub && typeof sub === "object") return { ...sub };
  }
  const legacy = readLegacyModelEntries(profilePath);
  return legacy.find((e) => e.type === type) ?? null;
}

/** 旧文件读取（标准数组优先，行式 JSONL 兜底）。 */
function readLegacyModelEntries(profilePath: string): MemorySystemModelEntry[] {
  const path = getLegacyModelConfigPath(profilePath);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");

  // 优先：标准 JSON 数组
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (e): e is MemorySystemModelEntry => e !== null && typeof e === "object",
      );
    }
  } catch {
    // 非标准 JSON（如历史 jsonl 残留）→ 按行回退
  }

  const entries: MemorySystemModelEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        entries.push(parsed as MemorySystemModelEntry);
      }
    } catch {
      // 坏行跳过，不阻塞其它条目
    }
  }
  return entries;
}
