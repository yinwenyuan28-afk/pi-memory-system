/**
 * application-propertis.json 统一配置中心读写（config/app-config.ts，2026-09-02）
 *
 * 背景：用户拍板扩展大部分配置统一收束到 {profile}/memoryDB/config/application-propertis.json，
 * 顶层按节组织（recall / vectorization / l1 / model ...），文件为 JSONC（支持注释）。
 * 本模块是所有收束节读写的唯一底层：
 *   - loadAppProps(profilePath)：读全文件（parseJsonc），不存在/非法 → null
 *   - saveAppSection(profilePath, section, value)：读-改-写合并，只更新指定节，
 *     同文件其他节（注释会丢，属预期）不受影响
 *
 * 各模块的 loadXxxConfig 负责「节 → 模块配置」的类型化合并与旧文件兜底；
 * 不要在业务模块里直接拼路径读文件。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DB_DIR } from "../memory/paths.js";
import { parseJsonc } from "../util/jsonc.js";

/** 统一配置中心文件名（相对 {profile}/memoryDB/）。 */
export const APP_CONFIG_FILE = join("config", "application-propertis.json");

/** 统一配置中心绝对路径。 */
export function getAppConfigPath(profilePath: string): string {
  return join(profilePath, MEMORY_DB_DIR, APP_CONFIG_FILE);
}

/** 宽松的全文件结构：顶层按节，节内容由各模块自行类型化。 */
export interface AppConfigFile {
  [section: string]: unknown;
}

/** 读取全文件（parseJsonc 支持注释）。不存在/非法 → null。 */
export function loadAppProps(profilePath: string): AppConfigFile | null {
  const filePath = getAppConfigPath(profilePath);
  if (!existsSync(filePath)) return null;
  try {
    const data = parseJsonc(readFileSync(filePath, "utf-8")) as AppConfigFile;
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/**
 * 更新指定节（读-改-写合并，原子写：tmp + rename）。
 * 其他节保持不变；节不存在则新建。文件不存在则从该节起建。
 */
export function saveAppSection(profilePath: string, section: string, value: unknown): void {
  const filePath = getAppConfigPath(profilePath);
  mkdirSync(join(profilePath, MEMORY_DB_DIR, "config"), { recursive: true });

  let appProps: AppConfigFile = {};
  try {
    if (existsSync(filePath)) {
      const parsed = parseJsonc(readFileSync(filePath, "utf-8"));
      if (parsed && typeof parsed === "object") appProps = parsed as AppConfigFile;
    }
  } catch {
    // 损坏则从空重建（配置可重建，不阻塞）
  }
  appProps[section] = value;

  const tmpPath = join(join(profilePath, MEMORY_DB_DIR), `.tmp_app_config_${Date.now()}`);
  writeFileSync(tmpPath, JSON.stringify(appProps, null, 2), "utf-8");
  try {
    rmSync(filePath, { force: true });
  } catch {
    // ignore
  }
  try {
    renameSync(tmpPath, filePath);
  } catch {
    writeFileSync(filePath, readFileSync(tmpPath, "utf-8"), "utf-8");
  }
  try {
    rmSync(tmpPath, { force: true });
  } catch {
    // ignore
  }
}
