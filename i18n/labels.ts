/**
 * i18n/labels.ts —— 展示层标签映射（数据值 → 词表键）
 *
 * 为什么需要这一层（而不是直接把中文当键去查词表）：
 * 有些中文串**既是页面上的标签，又是落盘/前后端约定的数据值**。典型的：
 * `memory/l1/quality.ts` 里 `tag` 字段存的就是 `热/温/冷/新/噪/待观察` 这几个汉字，
 * 查看器与扩展都拿它当查表键、筛选键、统计键。**翻译这个值会直接破坏数据一致性。**
 *
 * 所以做法是：数据值保持中文不动，**只在显示的那一刻**经本模块映射成词表键，
 * 由 `t()` 出对应语言的人类可读标签。即「翻的是显示，不是值」。
 *
 * 判据：只有**值本身是数据**的枚举才需要登记在这里；纯展示标签（如
 * `待办/已完成/已废弃`，其真数据是英文 `open/done/dropped`）走普通词表键即可。
 */
import { t } from "./index.ts";

/**
 * 质量分标签：数据值（中文，来自 `memory/l1/quality.ts` 的 `tag`）→ 词表键后缀。
 *
 * 键在词表里的位置：`ext.quality.tag.<hot|warm|cold|new|noise|watch>`。
 * 未登记的标签原样返回（不丢信息，也不炸）。
 */
export const QUALITY_TAG_KEYS: Record<string, string> = {
  热: "hot",
  温: "warm",
  冷: "cold",
  新: "new",
  噪: "noise",
  待观察: "watch",
};

/**
 * 把质量分数据值渲染成当前语言下的标签。
 *
 * @param tag 数据值（中文，如 `热`）
 * @returns 标签；未登记的取值原样返回
 */
export function qualityTagLabel(tag: string): string {
	const key = QUALITY_TAG_KEYS[tag];
	return key ? t(`ext.quality.tag.${key}`) : tag;
}

/**
 * 任务状态标签：真数据是英文 `open/done/dropped`，这里是**纯展示标签**，
 * 即词表里的普通键（`ext.task.state.<state>`）。放在本文件是为了让「哪些枚举
 * 需要映射」集中可见。
 */
export function taskStateLabel(state: string): string {
	return t(`ext.task.state.${state}`);
}
