# L1 审计输出契约（audit contract）

子代理对 L1 原子记忆执行「价值 + 准确性」审计时，**最终回复必须同时包含**：

1. **markdown 报告正文**（供人阅读）
2. **结构化 JSON 附件**（供机器消费，见下）

> 背景：2026-09-11 首轮 11 份审计报告因 markdown 表格格式各异（列序/引号/表头差异），解析脚本发生两次列位错位，主代理须逐份人工核对。契约化后审计可直接消费 JSON，报告回归纯展示层。

## JSON 格式

最终回复末尾追加 fenced JSON（语言标签 `json`，键名固定）：

```json
{
  "auditReport": {
    "bucket": "R1a",
    "generatedAt": "2026-09-11T01:00:00.000Z",
    "repoHeads": { "memory-system": "1f70c99", "A104527": "32827dba" },
    "findings": [
      {
        "recordId": "l1_1787206120003_c3d4",
        "value": "low",
        "accuracy": "不成立",
        "evidence": "memory/l1/quality.ts:134,146,160-174（quality=effective×decay×penalty，无 −invalid×0.5）",
        "disposition": "REWRITE",
        "note": "改写为现行公式；若作 evaluation_criterion 引用须同步语义"
      }
    ]
  }
}
```

## 字段约定

| 字段 | 取值 | 说明 |
|---|---|---|
| `bucket` | 审计桶名 | 与任务消息一致 |
| `repoHeads` | `{仓库名: commit}` | 取证基线（只读 git log -1）；无则省略 |
| `findings[].recordId` | l1_ 记录 id | 必填；不允许编造不存在的 id |
| `findings[].value` | `high / medium / low / none` | none=噪音/测试残留 |
| `findings[].accuracy` | `成立 / 部分成立 / 不成立 / 已过时 / 无法验证` | 无法验证=找到硬证据，禁止臆断 |
| `findings[].evidence` | `file:line / commit / grep 命中` | 必填；找不到证据则该条 accuracy=无法验证 |
| `findings[].disposition` | `KEEP / REWRITE / TOMBSTONE / MERGE / SPLIT` | 建议处置（主代理可改判） |
| `findings[].note` | 自由文本 | 处置要点/联动告诫（如「与 X 记录重复，合并到 <id>」） |

## 硬规则

- **一条记录一行 finding**，审计范围内记录全覆盖（缺一条 = 报告不合格，回退）。
- JSON 必须可被 `JSON.parse` 直接解析（fenced 块内无说明文字；如需说明写 markdown 正文）。
- 审计只读：不改任何文件；JSON 只是输出格式的一部分。
- 主代理消费流程：解析 JSON → 生成决策表 → 人工用 markdown 报告交叉抽检（≲10%）→ 决策定版。JSON 与报告矛盾时以 JSON 为准并记录。

## 配套

主代理审查此类审计时（如 RV1 决策一致性审查），可直接以 JSON 为输入做全量比对，无需再解析报告表格。