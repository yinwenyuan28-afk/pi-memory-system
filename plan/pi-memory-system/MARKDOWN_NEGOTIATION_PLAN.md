---
status: observing
created: "2026-10-12"
updated: "2026-10-12"
---

# Markdown 内容协商（2/3 done）

为宣传网站增加按 `Accept: text/markdown` 返回 Markdown 的能力，普通浏览器请求继续获取现有 HTML。

## 背景与问题

网站由 VitePress 生成静态站点，并由 Cloudflare Workers Static Assets 托管。当前 Wrangler 配置没有 Worker 入口，因此不能在请求时按 `Accept` 选择响应格式。Cloudflare 的 Markdown for Agents 可自动转换 HTML，但官方文档标明它受套餐和控制台设置限制；本计划在项目中实现独立的静态 Markdown 变体。

## 目标与验收

- 对现有中英文首页和文档页，携带可接受的 `text/markdown` 时返回 Markdown，状态码为 200，`Content-Type` 为 `text/markdown`。
- 未请求 Markdown 时，静态站点仍返回原 HTML 内容与正常状态码。
- VitePress 新增页面随构建自动纳入 Markdown 变体，无需手工维护 URL 映射。
- 构建成功；使用 Wrangler 本地预览验证 Markdown、HTML、robots.txt、sitemap.xml 和常见静态资源。
- 线上 scanner 中 `checks.contentAccessibility.markdownNegotiation.status` 为 `pass`（部署后检查）。

## 范围

- `website` 的构建、Worker 静态资源配置和请求处理。
- 现有中文/英文 Markdown 页面。

## 不做的事

- 不修改 Cloudflare 账户设置、不调用部署、不提交或推送。
- 不为图片、视频等非页面资源生成 Markdown。
- 不生成推测的 `x-markdown-tokens`；当前未引入 tokenizer。

## 已确认决策

| 决策 | 来源与确认时间 | 选择 | 理由与后果 | 被否选项 |
| --- | --- | --- | --- | --- |
| 按用户指定的内容协商要求实现 | 用户本轮明确要求“Implement content negotiation”，2026-10-12 | 通过 Worker 从构建产物中的 Markdown 页面副本提供响应 | 兼容当前静态部署，不依赖 Cloudflare Markdown for Agents 的付费套餐功能 | 仅要求用户在 Cloudflare 控制台启用功能 |

实施授权：用户本轮要求实施内容协商；范围限于仓库内实现与本地验证，不包括部署或推送。

### agent 实现裁决

| 事项 | 选择与理由 | 依据 |
| --- | --- | --- |
| Worker 路由 | 仅首页、文档页和内部 Markdown 路径使用 Wrangler Worker-first + ASSETS binding | Cloudflare Static Assets 官方配置支持 Worker-first 路径规则；避免让图片、视频、CSS、JS 等资源请求经过 Worker |
| Markdown 载体 | 构建时将公开页面源码复制到 dist 内部路径，由 Worker 仅在内容协商请求中读取 | 无转换依赖；与 VitePress 页面源码保持同步；Worker 拦截该内部路径的直接访问 |
| 变体缓存 | 对响应合并 `Vary: Accept` | HTTP 内容协商要求缓存区分 Accept 变体 |

## 方案设计

构建后将 `index.md`、`docs/**/*.md`、`en/index.md` 和 `en/docs/**/*.md` 复制到 dist 的内部 `_markdown/` 目录。Worker 解析 URL 并映射到该目录；仅当 GET/HEAD 请求明确接受 `text/markdown` 时返回 Markdown。其他请求继续通过 `env.ASSETS.fetch(request)` 获取现有静态站点。Worker 拦截对 `_markdown/` 路径的直接外部访问，并为内容协商响应设置 `Content-Type` 和 `Vary`。

## 风险/待确认

| 类型 | 事项及影响 | 应对/推荐方案 | 决策或解除条件 |
| --- | --- | --- | --- |
| 部署验证依赖 | 公网 scanner 只有部署后才能验证；本任务不授权部署/推送 | 本地构建与 Wrangler preview 验收，公网验证留待 Cloudflare 自动部署后执行 | 用户之后推送到已连接的 Cloudflare 部署分支 |
| 缓存 | Worker 现在会先于静态资产运行，所有流量多经过 Worker | 设置 `Vary: Accept`，尽量通过内部 Markdown 静态资产复用边缘缓存 | 本地及部署后观察 HTML 和 Markdown 变体 |

## 任务分解

| 编号 | 任务与验收 | 涉及文件 | 状态 | 依赖/备注 |
| --- | --- | --- | --- | --- |
| T1 | 加入构建后 Markdown 页面副本和内容协商 Worker；HTML 保持默认 | `website/scripts/copy-markdown.mjs`、`website/worker.ts`、`website/package.json`、`website/wrangler.jsonc`、`website/agent-content/*.md`、`website/.vitepress/config.mts` | done | 首页由 Vue 渲染，提供专用 Markdown 概览；文档页复制原始 Markdown |
| T2 | 构建成功，检查 Markdown/HTML 响应及内部资源路径屏蔽 | 本地 Wrangler preview、Wrangler dry-run | done | 构建产物为可复现临时输出 |
| T3 | 新 Worker 部署后，公网 scanner 确认为 pass | 公网 scanner | pending | 本地记录已更新；公网验证要等新 Worker 部署 |

## 文件改动清单

| 文件 | 操作 | 职责与改动意图 |
| --- | --- | --- |
| `website/wrangler.jsonc` | 修改 | 配置 Worker 主入口、Assets binding 和 Worker-first 行为 |
| `website/worker.ts` | 新增 | 实现 Accept 协商、Markdown 响应、Vary 及静态资产回退 |
| `website/scripts/copy-markdown.mjs` | 新增 | 把公开 VitePress 页面源码复制为部署静态资产 |
| `website/package.json` | 修改 | 构建完成后生成 Markdown 资产副本 |
| `website/.gitignore` | 修改 | 忽略 Wrangler 本地运行状态与缓存 |
| `website/agent-content/zh-home.md` | 新增 | 为中文 Vue 首页提供内容充实的 Markdown 版本 |
| `website/agent-content/en-home.md` | 新增 | 为英文 Vue 首页提供内容充实的 Markdown 版本 |
| `website/.vitepress/config.mts` | 修改 | 排除仅供 agent Markdown 响应使用的首页文案源文件 |
| `plan/pi-memory-system/README.md` | 修改 | 跟踪本计划状态 |

## 验证计划与结果

| 验收项 | 方法/命令 | 通过标准 | 实际结果与证据 | 未执行原因/剩余事项 |
| --- | --- | --- | --- | --- |
| 静态构建 | `npm run build`（website） | VitePress build 和 Markdown copy 均成功 | 通过：VitePress 生成 sitemap 后，脚本复制 Markdown 页面成功 | 无 |
| Worker 运行 | Wrangler 4.149.0 `dev --local` | Markdown Accept 返回 MD，默认请求返回 HTML，隐藏目录不公开 | 通过：中英文首页、中文/英文文档、尾随斜线、HEAD、`q=0`、HTML、robots.txt、`/_markdown/` 直访均符合预期 | 无 |
| 部署打包 | `npx wrangler deploy --dry-run` | Worker 与 Assets binding 正确解析并可打包 | 通过：读取 134 个静态文件，Worker 绑定 `ASSETS` | 未上传 |
| 公网 scanner | `POST https://isitagentready.com/api/scan` | `checks.contentAccessibility.markdownNegotiation.status` 为 `pass` | 未执行 | 需新 Worker 部署后验证；本次未推送或部署 |

## 观察项

| 观察项 | 判定标准与方式 | 当前证据 | 责任人 | 下一次检查条件 |
| --- | --- | --- | --- | --- |
| 公网 Markdown negotiation scanner | scanner 返回 `checks.contentAccessibility.markdownNegotiation.status === "pass"` | 本地 Worker 行为和 Wrangler dry-run 通过；线上尚未部署本变更 | 部署后由用户或后续会话检查 | 新版本推送并完成 Cloudflare 自动部署后 |

## 实施记录

- 2026-10-12：读取用户提供的 skill 指南与 Cloudflare 官方 Markdown for Agents、Static Assets 文档。官方自动转换能力由 Cloudflare zone 设置且有套餐限制；当前仓库使用静态 Workers Assets，决定实现仓库内内容协商以保证可用。
- 2026-10-12：完成 Worker、构建后 Markdown 副本和中英文首页 agent 文案；本地构建、请求行为及 Wrangler dry-run 均通过。公网 scanner 等新 Worker 部署后验证。

## 完成结论

内容协商已实现；本地构建与响应验证通过。计划保持 `observing`，因为公网 scanner 需在新版本部署后确认通过；本任务未执行提交、推送或部署。
