#!/usr/bin/env node
// ============================================================================
// verify-i18n.mjs —— 界面词表门禁
//
// 用法：node scripts/verify-i18n.mjs
//
// 校验项（都只做**精确、零误报**的检查，刻意不做「硬编码中文扫描」——
// 那种按字符类扫法误报高、还会放过真正的中英混用不一致问题）：
//
//   1. 键对等：每个非源语言与源语言 zh-CN 的扁平键集**完全一致**
//      （缺键 = 该语言漏翻；多键 = 键名写错或源语言删了键没同步）。
//   2. 未译检测：非源语言词表的值里不得残留汉字（技术 token 本就不含汉字，
//      自动通过；确有需要保留中文的键走 CJK_ALLOWLIST）。
//   3. 占位一致：同一键在各语言里的 `{{param}}` 集合必须相同
//      （否则译文会在运行时留下字面量 {{x}}，或丢参数）。
//
// 退出码：有任何 FAIL → 1，否则 0。
// ============================================================================

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCALES_DIR = join(EXT_ROOT, "i18n", "locales");
const SOURCE = "zh-CN";

let failures = 0;
const fail = (msg) => { console.error(`FAIL ${msg}`); failures++; };
const ok = (msg) => console.log(`  ok  ${msg}`);

/** 允许在非源语言里保留汉字的键（正常为空；仅当某键的价值就在于引述中文数据时才登记）。 */
const CJK_ALLOWLIST = new Set([
  // 例：展示层把中文数据值（热/温/冷…）映射成标签时，英文标签本身不含汉字，故无需登记。
]);

/** 嵌套对象拍平成「点号路径 → 字符串值」。 */
function flatten(value, prefix, out) {
  if (typeof value === "string") { out.set(prefix, value); return; }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
}

/** 读一个词表并拍平。 */
function loadCatalog(locale) {
  const file = join(LOCALES_DIR, `${locale}.json`);
  const out = new Map();
  flatten(JSON.parse(readFileSync(file, "utf-8")), "", out);
  return out;
}

const CJK = /[\u3400-\u9fff]/;
/** 取一个模板里的 `{{param}}` 名集合。 */
const paramsOf = (s) => new Set([...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));

// ── 0) 目录与源语言存在性 ─────────────────────────────────────────────────
console.log("── 0) 词表目录");
if (!existsSync(LOCALES_DIR)) { fail(`词表目录不存在：${LOCALES_DIR}`); process.exit(1); }
const locales = readdirSync(LOCALES_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
if (!locales.includes(SOURCE)) { fail(`源语言词表缺失：${SOURCE}.json`); process.exit(1); }
ok(`发现 ${locales.length} 种语言：${locales.join(", ")}（源语言 ${SOURCE}）`);

const source = loadCatalog(SOURCE);
const sourceKeys = new Set(source.keys());
ok(`源语言共 ${sourceKeys.size} 个键`);

// ── 1/2/3) 逐语言比对 ─────────────────────────────────────────────────────
for (const locale of locales) {
  if (locale === SOURCE) continue;
  const catalog = loadCatalog(locale);
  console.log(`── ${locale}`);

  // 1) 键对等
  const missing = [...sourceKeys].filter((k) => !catalog.has(k));
  const extra = [...catalog.keys()].filter((k) => !sourceKeys.has(k));
  if (missing.length === 0 && extra.length === 0) {
    ok(`键对等（${catalog.size} 个键）`);
  } else {
    if (missing.length) fail(`${locale}: 缺 ${missing.length} 个键 → ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}`);
    if (extra.length) fail(`${locale}: 多 ${extra.length} 个键 → ${extra.slice(0, 8).join(", ")}${extra.length > 8 ? " …" : ""}`);
  }

  // 2) 未译检测（只查两边都有的键）
  const untranslated = [];
  for (const [key, value] of catalog) {
    if (!sourceKeys.has(key)) continue;
    if (CJK_ALLOWLIST.has(key)) continue;
    if (CJK.test(value)) untranslated.push(key);
  }
  if (untranslated.length === 0) ok("无残留汉字（未译）");
  else fail(`${locale}: ${untranslated.length} 个键仍是中文 → ${untranslated.slice(0, 8).join(", ")}${untranslated.length > 8 ? " …" : ""}`);

  // 3) 占位一致
  const badParams = [];
  for (const [key, value] of catalog) {
    if (!sourceKeys.has(key)) continue;
    const a = paramsOf(source.get(key));
    const b = paramsOf(value);
    const same = a.size === b.size && [...a].every((p) => b.has(p));
    if (!same) badParams.push(`${key}（源 {${[...a].join(",")}} vs 译 {${[...b].join(",")}}）`);
  }
  if (badParams.length === 0) ok("占位参数一致");
  else fail(`${locale}: ${badParams.length} 个键的 {{占位}} 不一致 → ${badParams.slice(0, 5).join("; ")}${badParams.length > 5 ? " …" : ""}`);
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log("");
if (failures > 0) { console.error(`✗ i18n 词表校验失败（${failures} 项）`); process.exit(1); }
console.log("✓ i18n 词表校验通过");
