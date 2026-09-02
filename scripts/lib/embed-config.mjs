/**
 * 自包含 embedding 配置读取（scripts/lib/embed-config.mjs，2026-09-02）
 *
 * 供 sample-recall-scores.mjs / rebuild-l1-vectors.mjs 复用（脚本不 import 扩展 TS 模块）。
 * 读取链：
 *   1) {profile}/memoryDB/config/application-propertis.json 的 model.embedding 节（JSONC，支持注释）
 *   2) 兜底旧 memory-system-model.json（*.legacy-* 备份或原名）
 * 返回 { apiKey, url, model, dimensions, qpmLimit }，缺必填返回 null。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** JSONC 去注释（字符串内 // 与定界符原样保留，字符串外剥行/块注释）。 */
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") { inBlock = false; i += 2; } else i++;
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { if (n !== undefined) out += n; i += 2; continue; }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === "/" && n === "/") { inLine = true; i += 2; continue; }
    if (c === "/" && n === "*") { inBlock = true; i += 2; continue; }
    out += c;
    i++;
  }
  return out;
}

function parseJsonc(text) {
  return JSON.parse(stripJsonComments(text));
}

/** 兜底：旧 memory-system-model.json（legacy 备份或原名）。返回 type=embedding 条目。 */
function readLegacyEmbeddingEntry(profilePath) {
  const dir = join(profilePath, "memoryDB", "config");
  for (const name of ["memory-system-model.json", "memory-system-model.json.legacy-20260902"]) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf-8");
      let arr = null;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) arr = parsed;
      } catch {
        arr = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
      }
      const emb = (arr ?? []).find((e) => e?.type === "embedding");
      if (emb?.apiKey && emb?.url) return emb;
    } catch { /* 尝试下一个 */ }
  }
  return null;
}

/** 读取 embedding 配置；不可用返回 null。 */
export function readEmbedConfig(profilePath) {
  // 1) 统一配置中心 model.embedding 节
  const appPath = join(profilePath, "memoryDB", "config", "application-propertis.json");
  if (existsSync(appPath)) {
    try {
      const props = parseJsonc(readFileSync(appPath, "utf-8"));
      const emb = props?.model?.embedding;
      if (emb && typeof emb === "object" && emb.apiKey && emb.url) {
        return {
          apiKey: emb.apiKey,
          url: String(emb.url).replace(/\/$/, ""),
          model: emb.model ?? "qwen3.7-text-embedding",
          dimensions: emb.dimensions ?? 1024,
          qpmLimit: emb.qpmLimit ?? 60,
        };
      }
    } catch { /* 落到兜底 */ }
  }
  // 2) 旧文件兜底
  const legacy = readLegacyEmbeddingEntry(profilePath);
  if (!legacy) return null;
  return {
    apiKey: legacy.apiKey,
    url: String(legacy.url).replace(/\/$/, ""),
    model: legacy.model ?? "qwen3.7-text-embedding",
    dimensions: legacy.dimensions ?? 1024,
    qpmLimit: legacy.qpmLimit ?? 60,
  };
}
