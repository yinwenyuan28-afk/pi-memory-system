# workflow_note 使用指南（辅助上下文记录规则）

> 面向 agent 的完整规则参考。workflow_note 工具描述只有精简版，需要完整规则时 read 本文件。
> 核心原则：**在认知闭环完成时刻记录**——定位到/修复好/拍板完/验证过之后，而不是过程进行中。
> workflow_context 记录"开发中需要记住的知识"（认知闭环时刻主动记录）。

## 一、记录时机（7 条触发规则）

在以下开发事件**完成**后，主动调用 workflow_note 记录一条上下文：

| #   | 触发事件（完成之后）                                 | 类别                   | 记录内容                                           |
| --- | ------------------------------------------ | -------------------- | ---------------------------------------------- |
| R1  | **集成点定位成功**（grep/find/read 确认现成类/服务/jar 后） | dependency / api     | 存在什么、在哪个包/文件、怎么调用（如：复用现有代理、企业 ID 获取链、附件绑定契约）   |
| R2  | **外部接口契约获取**（用户提供文档/样例，或从代码确认第三方接口）        | api                  | 入参/出参/认证/白名单；**未联调验证的契约必须标注 verified=0**       |
| R3  | **踩坑修复闭环**（报错 → 定位根因 → 修复 → 编译通过）          | pitfalls             | 症状（含异常签名）+ 根因（谁引起）+ 修复（排除依赖/锁版本/换 API），附类名/版本号 |
| R4  | **技术选型定夺**（用户拍板或审查采纳方案时）                   | decisions            | 选项、选定项、理由、被否选项                                 |
| R5  | **验证通过**（spike/单测/冒烟成功）                    | verification         | 验证方法、验收标准、量化结果                                 |
| R6  | **环境/配置事实确认**（编译命令、白名单、测试开关、部署环境）          | config / commands    | 事实与出处                                          |
| R7  | **安全/并发约束确立**（审查发现或代码设计时）                  | pitfalls / decisions | 约束内容、为什么（如：幂等防双签、日志脱敏）                         |

**触发时机特征**：每条规则的触发点都是"认知闭环"的完成时刻，不是过程进行中。遇到多个小坑合并成一条记录（如三个编译报错同根因 → 一条）。

## 二、质量标准

- **一条记录 = 一个可复用知识点**：发生了什么、根因/结论、位置/出处（类名/接口/版本号）
- **具体到名字**："docx4j 6.1.0"而非"某个库"；"NoSuchMethodError: CMapParser.<init>(Z)"而非"报错"
- **区分验证状态**：外部契约未联调标 verified=0，防后续误当已确认事实
- **三类必须分开记**（防重复）：
  - 最终版本/排除项 → config
  - 版本兼容性踩坑 → pitfalls
  - 选型理由 → decisions

## 三、读取时机（何时用 workflow_context 工具）

- **会话重启/续接后**：先读当前工作流全部 context，恢复开发备忘（续接注入只带最近 5 条，完整靠工具）
- **开工新子任务前**：查相关类别（如写转换代码前先读 pitfalls 的 docx4j 坑）
- **遇到相似需求/报错时**：按类别检索（api/commands/config），避免重复踩坑
- **续接注入优先级**：verification + decisions 优先 → pitfalls → api/config/commands/dependency（系统已按此排序）

## 四、示例（来自真实工作流 A104527）

```
# R3 踩坑（pitfalls）— 好例子：
docx4j 6.1.2 → NoSuchMethodError: org.apache.fontbox.cmap.CMapParser.<init>(Z)
根因: fop 2.3 传递依赖 fontbox 2.0.7 覆盖 pdfbox-app 2.0.24
修复: pom 的 fop 依赖排除 fontbox（已验证）

# R1 集成点（dependency）— 好例子：
企业 ID 获取: cb06Service.getByUserId(userId).getUnitId()
Cb06 实体在 job.entity 包（非 enterprise.entity）
附件绑定: upload(file, businessType, businessId=null) → updateBatchByAttachmentId(businessId, ids)

# R2 外部契约（api，verified=0）— 好例子：
银海 ktSealPdf: POST /business/ecosystem/osp/ktSealPdf
入参 {sealid, certPassword, page:0, keyword, signType:"0", fileName, base64Str:PDF}
响应 HttpLocalResponse{code,message,data}，data=biz_data(base64 PDF 或 JSON)
⚠ 未联调验证（dev 环境需先补白名单）→ verified=0

# 反例（太模糊，不记）：
"docx4j 有坑" ❌
"改了字体映射" ❌
"测试通过了" ❌
```

## 五、与全局记忆的分工

- **全局环境/工具事实**（bash 转义、Java8 通用限制、跨项目通用）→ **memory 工具**存全局记忆
- **本项目/本工作流特定事实**（某类在哪个包、本接口怎么调、本工作流踩的坑）→ **workflow_note**
- 判断标准：换一个项目还能用 → 全局；只对这个工作流/项目有意义 → workflow_context
