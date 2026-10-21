---
title: 为 Pi 提供长期记忆支持
description: 把对话中的项目事实、工作方法和待办积累下来，在后续工作中按需找回。
---

# 为 Pi 提供长期记忆支持

Pi Memory 是面向持续项目工作的 Pi 扩展。它将对话里有复用价值的项目事实、工作方法和待办整理成长期记忆，让 Pi 在后续相关工作中按需找回，减少重复交代。

## 工作流程

1. **归档对话：**保存经过净化的用户与助手正文，作为后续整理的来源。
2. **提炼可用信息：**在后台把对话整理为事实、待办、方法和工作资产。
3. **按问题找回：**配置 Embedding 并为记录建立向量后，可按当前问题检索相关内容。

相关记录还可以整理为场景；画像更新会先作为提议供用户审阅，不会自动覆盖正式画像。

## 主要能力

- 在本地查看器中检查记忆记录与来源、纠正不准确内容并管理待办状态。
- 审阅画像提议后再决定是否并入正式画像。
- 将可重复的排查或操作流程提炼为可复用技能。
- 记忆文件保存在 Pi profile 中。后台提取和向量化是否调用外部服务，取决于用户配置的模型与 Embedding 服务。

## 安装

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.83.0
pi install npm:pi-memory-system
```

当前面向 Windows，Pi 0.83.0 需要 Node.js 22.19 或更高版本。语义召回需要另行配置 Embedding、开启向量化，并为已有记录回填向量。

## 文档

- [快速开始](/docs/quickstart)
- [配置语义召回](/docs/recall)
- [记忆如何工作](/docs/memory)
- [上下文与渐进式设计](/docs/context-design)
- [限制与数据说明](/docs/limits)

## 同作者的其他项目

- [cursor-encoding-fix](https://github.com/yinwenyuan28-afk/cursor-encoding-fix)：专治简体中文 Windows 上 Cursor Agent 把中文静默存成 GBK 的问题，通过 MCP 工具读写文件并统一落盘为无 BOM 的 UTF-8。

[GitHub 项目](https://github.com/yinwenyuan28-afk/pi-memory-system) · [联系邮箱](mailto:email@pi-memory.com)
