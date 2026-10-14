/**
 * i18n/command.ts —— `/my-memory:language` 命令
 *
 * 职责：查看当前语言、切换语言（`auto` 或某个具体语言名）。切换只做两件事：
 *   1. 写配置 `<profile>/memoryDB/config/application-propertis.json` 的 `language.locale`
 *   2. 让新语言在**本进程内立即生效**（refreshLocaleFromConfig）
 *
 * 为什么写完要提示 `/reload`：命令与工具的 description 是在扩展工厂期一次性注册的字符串，
 * pi 的 `registerCommand` 没有更新入口，重注册 ~16 个命令得不偿失。所以诚实地告诉用户
 * 「命令说明/历史卡片要下次 reload 才刷新」，而不是假装切了就全变了。
 *
 * 与 config/model-setup.ts 同构：命令注册收在独立模块里，由 index.ts 一行挂上，
 * 避免把 UI 细节继续堆进 index.ts。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AUTO,
  getLocale,
  listLocales,
  readLanguageSetting,
  refreshLocaleFromConfig,
  t,
  writeLanguageSetting,
} from "./index.ts";

/** 把配置值渲染成人话：`auto`/未配置 → 「自动（跟随系统区域）」，否则原样。 */
function describeConfigured(value: unknown): string {
  if (value === undefined || value === null || String(value).toLowerCase() === AUTO) {
    return t("ext.language.auto");
  }
  return String(value);
}

/**
 * 注册语言命令。
 *
 * @param pi             扩展 API
 * @param getProfilePath 取活跃 profile 根目录（无活跃 profile 时返回 undefined）
 */
export function registerLanguageCommand(
  pi: ExtensionAPI,
  getProfilePath: () => string | undefined,
): void {
  // 语言清单在注册期（工厂）就已确定：目录列举不依赖 profile，故 description 里的选项是准的。
  const options = listLocales().join("|");

  pi.registerCommand("my-memory:language", {
    description: t("ext.command.language.description", { options }),
    usage: t("ext.command.language.usage", { options }),
    handler: async (args, ctx) => {
      const locales = listLocales();
      const value = (args || "").trim();

      // 无参数：报告当前语言与配置来源
      if (!value) {
        const profilePath = getProfilePath();
        ctx.ui.notify(
          t("ext.language.current", {
            locale: getLocale(),
            configured: describeConfigured(readLanguageSetting(profilePath)),
            options: locales.join(", "),
          }),
          "info",
        );
        return;
      }

      // 解析目标：auto 或目录里实际存在的语言（大小写不敏感）
      const target = value.toLowerCase() === AUTO
        ? AUTO
        : locales.find((l) => l.toLowerCase() === value.toLowerCase());
      if (!target) {
        ctx.ui.notify(
          t("ext.language.unknown", { value, options: locales.join(", ") }),
          "warning",
        );
        return;
      }

      const profilePath = getProfilePath();
      if (!profilePath) {
        ctx.ui.notify(t("ext.notify.noProfile"), "error");
        return;
      }

      try {
        writeLanguageSetting(profilePath, target);
        // 立即在本进程生效：后续 notify/报告/状态栏都用新语言
        refreshLocaleFromConfig(profilePath);
        ctx.ui.notify(
          t("ext.language.switched", {
            configured: describeConfigured(target),
            locale: getLocale(),
          }),
          "info",
        );
      } catch (e) {
        ctx.ui.notify(
          t("ext.language.writeFailed", { message: e instanceof Error ? e.message : String(e) }),
          "error",
        );
      }
    },
  });
}
