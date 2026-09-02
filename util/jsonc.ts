/**
 * JSONC（JSON with comments）解析工具（2026-09-02）
 *
 * 背景：扩展配置收束到 application-propertis.json 后，希望能在配置文件内直接写
 * 注释标注字段语义（标准 JSON 不支持注释）。本模块提供去注释 + 解析。
 *
 * 实现：逐字符状态机，正确处理：
 *   - 字符串字面量内（双引号包裹）的注释定界符原样保留（如 URL 中的 https:// 不会被误剥）
 *   - 转义（反斜杠加双引号等）
 *   - 行注释（双斜杠开头）、块注释（斜杠星号包裹）——仅在字符串外剥离
 * 剥离后输出仍是合法 JSON，可直接 JSON.parse。
 *
 * 注意：本文件注释中不得出现块注释定界符字面量（斜杠星号），否则会让 TS 词法
 * 提前截断文档注释（2026-09-02 踩坑）。
 *
 * 用法：所有读取 JSON 配置的地方换成 parseJsonc(readFileSync(...))，
 * 即可在配置文件中写行注释或块注释（save 写回时不保留注释，属预期）。
 */

/** 剥离 JSONC 注释，返回合法 JSON 文本。 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const c = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      i++;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        if (next !== undefined) out += next;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    // 字符串外
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 解析 JSONC 文本（剥离注释后 JSON.parse）。 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}
