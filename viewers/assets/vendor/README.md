# viewers/assets/vendor —— 内置的第三方前端库（Vue 3 + Element Plus）

## 为什么是"内置文件"而不是 npm 依赖 / 构建产物

这一版的查看器用 **Vue 3 + Element Plus** 重构（2026-10-10），但**不引入构建步骤**。原因不是
"省事"，而是这个仓库里三条已经成立的事实：

1. **部署靠内容哈希逐文件同步**。`memory/viewers/deploy.ts` 扫 `viewers/` 下每个文件、算 sha256、
   写进 `{profile}/memoryDB/viewers/`，版本号 = `包版本+内容哈希前 8 位`。只要库文件是**仓库里的
   普通文件**，它就自动被这套机制带上，`/api/viewer-status` 的漂移检测也自动覆盖它们 ——
   不需要给部署器加"要不要拷贝 node_modules/dist"这类分支。
2. **页面是 classic script，没有打包器**。`file://` 下浏览器禁止 ES module 与 fetch，但允许
   `<script src>`；用 UMD/global 版（`vue.global.prod.js`、`index.full.min.js`）可以继续直接双击
   打开并渲染（只是取不到数据），这与 `viewer-core.js` 文件头写下的取舍一致。
3. **上一次 Vue 化的失败原因就在这里**。2026-08-23 的 `vue-viewer/` 是个 **Vite 工程**：
   `package.json` + `src/*.vue` + `vite.config.js`，没有 `node_modules`、没有 `dist`，
   于是"源码在仓库、运行位置由代码同步"这条链路根本没接上，最终被 `deploy.ts` 的
   `RETIRED_PATHS` 移进 `backups/viewers-retired/`。**构建产物不是不能进仓库，是当年那套没有任何
   东西保证它跟版**。内置 UMD 文件把这个问题绕开了：没有产物，源文件本身就是产物。

代价（值得记下来）：仓库里多约 1.6 MB 二进制式内容，升级第三方库要手工重下 + 重跑门禁。
升级步骤见文末。

## 文件与出处（版本固定，勿浮动）

| 文件 | 来源 | 版本 | 字节 | sha256 |
|---|---|---|---|---|
| `vue.global.prod.js` | `https://unpkg.com/vue@3.5.43/dist/vue.global.prod.js` | 3.5.43 | 168,331 | `b72394052eef1eeda1752db3758ce1be6f88016903f22e5241cc732ea307478e` |
| `element-plus/index.full.min.js` | `https://unpkg.com/element-plus@2.14.7/dist/index.full.min.js` | 2.14.7 | 1,057,566 | `7f38e2550c046e823d84ed16c2a70caaca6d7e7071b060c96526766d46d56ab1` |
| `element-plus/index.css` | `https://unpkg.com/element-plus@2.14.7/dist/index.css` | 2.14.7 | 361,441 | `d78229097f1ec25311afa285e86aa5af6e768d541a65dd0c6d4c7ac0831b02f0` |
| `element-plus/dark.css` | `https://unpkg.com/element-plus@2.14.7/theme-chalk/dark/css-vars.css` | 2.14.7 | 2,946 | `28e7253e91dab71d259970d7c2b21674ceffa29fa446f5968a40933215161600` |
| `element-plus/locale-zh-cn.min.js` | `https://unpkg.com/element-plus@2.14.7/dist/locale/zh-cn.min.js` | 2.14.7 | 4,185 | `7909a2cfe5b826f0686a7abb4845fe8c9e0bf3d31b90a9a00f0d3052b5c217e6` |
| `element-plus/LICENSE` | `https://unpkg.com/element-plus@2.14.7/LICENSE` | 2.14.7 | 1,077 | — |

Vue 的 MIT 许可声明在 `vue.global.prod.js` 文件头（`@license MIT`）；Element Plus 同样 MIT，
许可证原件随包放在 `element-plus/LICENSE`。

## 三个加载顺序约束（写错了页面直接白屏）

1. **Vue 必须在 Element Plus 之前**：EP 的 UMD 包装是
   `(function(e,t){ … t(e.ElementPlus={}, e.Vue) })(this, …)` —— 它在**加载时**就取全局 `Vue`，
   顺序反了 `ElementPlus` 是个空壳。
2. **locale 必须在 Element Plus 之后**（它挂 `ElementPlusLocaleZhCn` 全局），
   但在 `viewer-vue.js` 之前（后者在 `app.use()` 时要用它）。
3. **`viewer-core.js` 在 `viewer-vue.js` 之前**：Vue 层要把 `window.V` 注入为全局属性。

固定顺序（每个页面的 `<body>` 末尾）：

```html
<script src="assets/vendor/vue.global.prod.js"></script>
<script src="assets/vendor/element-plus/index.full.min.js"></script>
<script src="assets/vendor/element-plus/locale-zh-cn.min.js"></script>
<script src="assets/viewer-core.js"></script>
<script src="assets/viewer-vue.js"></script>
<script src="assets/<页面>-app.js"></script>
```

样式表顺序：`element-plus/index.css` → `element-plus/dark.css` → `viewer-theme.css`（最后一份覆盖前两份）。

## 升级步骤

1. 从 unpkg 下载新版本到临时目录（按上表同样的路径），确认两个全局仍在：
   `node -e "const s=require('fs').readFileSync('index.full.min.js','utf8'); console.log(/ElementPlus/.test(s))"`。
2. `sha256sum` 更新上表（**表要与文件同步改**，否则这张表本身就是新的错误来源）。
3. 覆盖到本目录，然后在**浏览器里真开一次五个页面**（`scripts/verify-viewer-deploy.ts` 只能证明
   引用存在，证明不了新版组件还能正常渲染）。
4. 跑 `npm run verify:viewer` 与 `verify:viewer-quality`，再按 `README.md` 的"界面约定"看一遍
   主题令牌是否仍然生效（EP 大版本会重命名 `--el-*` 变量，主题桥会静默失效 —— 这是升级最容易漏的一环）。
