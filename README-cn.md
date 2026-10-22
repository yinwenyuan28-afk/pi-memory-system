# pi-memory-system

让 Pi 在工作过程中记住项目事实、决策和用户偏好，并在后续对话中按需召回。扩展会把记忆逐步整理为原子记录、场景信息和用户画像。

官方网站：[pi-memory-system](https://pi-memory-system.yinwenyuan28.workers.dev/) · [备用站点](https://pi-memory.com)  
联系邮箱：[email@pi-memory.com](mailto:email@pi-memory.com)

English: [README.md](README.md)

## 功能概览

- 自动从会话中提取记忆，之后按需检索并注入相关内容。
- 按 L1 原子记录、L2 场景块、L3 用户画像分层整理。
- 为待办记忆提供完成、废弃和重新打开状态。
- 提供本地记录查看器，检查记忆数据、处理队列和画像提议稿。

## 环境要求

- **仅支持 Windows。** 子代理停止依赖 Windows 进程树语义，项目归属判断也使用盘符路径规则。
- **Node.js >= 22.13.0。**
- 已实测的 Pi 版本组合：pi 0.84.2、pi-coding-agent 0.83.0、pi-ai 0.74.2。其他版本尚未在此处承诺兼容性。

## 安装

从 npm 安装：

    pi install npm:pi-memory-system

安装后在 Pi 中运行 **/reload**，或重启 Pi。

如果之前把扩展手动放在 **~/.pi/agent/extensions/memory-system**，请先将旧目录移出 extensions，再执行包安装。Pi 会同时扫描目录扩展和 package 配置；两处都保留会导致重复加载和同名工具注册。

从本地源码安装时，传入仓库目录：

    pi install ./path/to/pi-memory-system

**不要把 .tgz 文件直接交给 pi install。** 如果要测试 tarball，先解压，再安装解压得到的目录。

## 首次使用

安装并重新加载后，扩展会自动运行基础记忆流程。向量化默认关闭，不配置 Embedding 服务也不会自动开启。

常用命令：

- **/my-memory:model**：配置后台 LLM 和 Embedding 服务，并明确开启或关闭向量化。
- **/my-memory:model:peek**：只读查看当前 profile 的模型、向量化配置和本地向量状态。
- **/my-memory:l1:task list**：列出未关闭的待办记忆；用 **done**、**drop** 或 **reopen** 加记录 ID 更新状态。
- **/my-memory:profile list**：查看可用 profile；用 **/my-memory:profile switch &lt;name&gt;** 切换。

配置文件会在首次运行时创建于当前 Pi profile 下：

    <agentDir>/profiles/<profile>/memoryDB/config/application-propertis.json

向量化需要配置兼容的 Embedding 服务。录入 API Key 时，Pi 当前扩展界面不会遮蔽输入内容；保存后 Key 位于 profile 配置文件中。修改 Embedding 配置后建议重启 Pi。

## 数据和查看器

记忆数据按当前 profile 保存在本机。开启后台 LLM 或向量化时，相关处理会使用你配置的模型或 Embedding 服务。

从源码仓库启动查看器：

    npm run viewer

查看器默认仅监听本机，但它能读取记忆并执行部分写入操作。局域网模式没有鉴权，只应在可信网络中使用。完整操作说明和安全边界见[记录查看器指南](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/docs/viewer-guide.md)。

## 界面语言

扩展的界面文案（命令说明、提示、状态栏、报告）支持中英双语，默认**自动跟随系统区域**：英文系统用英文，中文系统用中文。

用命令查看或切换：

    /my-memory:language            # 查看当前语言
    /my-memory:language en         # 切英文
    /my-memory:language zh-CN      # 切中文
    /my-memory:language auto       # 回到自动探测

切换后**执行一次 /reload**（命令说明与已渲染的卡片在下次加载才刷新；状态栏会立即变）。也可以直接改配置文件 `<profile>/memoryDB/config/application-propertis.json` 的 `language.locale`。

新增一门语言只需在 `i18n/locales/` 放一个 `<lang>.json`，无需改代码，详见 [i18n 说明](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/i18n/README.md)。

## 已知限制

- 向量化默认关闭；启用后需要配置 Embedding 服务。已有向量数据时，不要直接更改 Embedding 维度。
- 切换 profile 会更新 Pi 的 **settings.json** 中 **memorySystem.activeProfile**。
- 扩展不会向 **~/.pi/agent/agents/** 写入子代理文件；子代理定义随扩展提供。

## 开发与发布

开发依赖、检查命令、查看器门禁和 npm 发布步骤见[开发与发布指南](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/docs/development.md)。系统设计细节见[记忆系统架构说明](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/%E8%AE%B0%E5%BF%86%E7%B3%BB%E7%BB%9F%E6%9E%B6%E6%9E%84%E8%AF%B4%E6%98%8E.md)。
