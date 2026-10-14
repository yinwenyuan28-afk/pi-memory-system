# 开发与发布

本文中的源码路径按仓库根目录解释。

```bash
git clone git@github.com:yinwenyuan28-afk/pi-memory-system.git
cd pi-memory-system
npm install            # ← 必须先做，见下方「为什么 npm install 是必需的」
```

### 门禁

```bash
npm run check-types   # 类型门禁（无构建仓库里唯一能拦住「名字写错/模块写错」的东西）
npm test              # 提示词契约逐字节校验 + i18n 词表校验
```

回归脚本在 `scripts/verify-*.ts`，共 20 多个、1400+ 项断言。跑法（Node ≥ 22.13 自带类型剥离，**不需要 jiti**）：

```bash
# 单个
node --conditions=import --experimental-strip-types scripts/verify-xxx.ts

# 全部
for f in scripts/verify-*.ts scripts/verify-*.mts scripts/verify-prompt-contracts.mjs scripts/verify-i18n.mjs; do
  node --conditions=import --experimental-strip-types "$f" || echo "!! 失败: $f"
done
```

`--conditions=import` 不能省：`config/model-config.ts` 静态 import `@earendil-works/pi-ai/compat`，
该包的 `exports` 只声明了 `import` 条件。

改查看器（`viewers/`）时另有两个针对性门禁：

```bash
node --conditions=import --experimental-strip-types scripts/verify-viewer-quality-parity.ts  # 质量分 JS ↔ TS 数值全等
node --conditions=import --experimental-strip-types scripts/verify-viewer-deploy.ts          # 部署机制 + 静态完整性
```

后者包含三条**不需要浏览器**的检查，都是开发期真实踩到过的错：查看器 JS 的语法、
HTML 引用的资源是否存在、页面调用的 `/api/*` 端点在 `viewer-bridge.mjs` 里是否真的声明了。

改界面文案（`i18n/`）时：

```bash
node scripts/verify-i18n.mjs   # 键对等 + 未译检测 + 占位一致（已随 npm test 一起跑）
```

只做三项**精确**检查：各语言键集与源语言 `zh-CN` 完全一致、非源语言词表里不得残留汉字、
同一键的 `{{占位}}` 集合跨语言一致。**刻意不做**「硬编码中文扫描」——那种按字符类扫法误报高，
还会放过真正的中英混用不一致问题。新增语言的步骤见 `i18n/README.md`。

### 为什么 `npm install` 是必需的

两个原因，都不会在加载时报错，只在运行时炸：

1. **原生模块**：`better-sqlite3` / `sqlite-vec` 是 `memory/search/vector-store/store.ts:134-135`
   的**运行时动态 import**。不装的话插件能正常加载、工具也都在，但**第一次写向量库时**
   （即 L1 提交记忆时）才失败——这种延迟失败极难归因。
2. **类型门禁的解析来源**：三个 `@earendil-works/*` 包声明为 `devDependencies`。

> ⚠ **不要把那三个 devDependencies 改成宿主正在用的版本。** 它们锁在 `0.83.0` 是有原因的：
> `@earendil-works/pi-ai/compat` 这个子路径**在 npm 发布的 0.74.2 里不存在**（`exports`
> 只有 `.`），只有 0.83.0 才有。改成 0.74.2 会让类型门禁报 29 处 `TS2307 Cannot find module`。
> 运行时不需要它们——pi 的扩展加载器通过 jiti 别名 / Bun virtualModules 把这些包指向 pi
> 自己 bundle 的副本，扩展 import 它们不落 `node_modules`。devDependencies 只为类型检查存在。

### 发布

```bash
node scripts/check-types.mjs                      # 先过门禁
npm version patch                                 # 版本号一旦占用即永久作废，务必先改
npm pack --pack-destination C:/temp/pi/release
npm publish C:/temp/pi/release/pi-memory-system-<版本>.tgz
```

三点：**发布前确认 `git status` 干净**；**README/LICENSE 在 `files` 白名单里，改过就要重打包**；
**`pi install` 不接受 `.tgz` 路径**（见「安装」一节）。
