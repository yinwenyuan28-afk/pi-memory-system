---
vars: profilePath, userMdPath, userTempMdPath, cursorPath, sceneDir, indexPath, promptDir, promptFile, changedScenes, triggerReason, mode, charLimit, entryCharLimit
---
L3 persona generation task
ProfilePath: {{profilePath}}
UserMdPath: {{userMdPath}}  （live 画像，**只读**：去重与语义比对看它；你改不动它）
UserTempMdPath: {{userTempMdPath}}  （写入稿：`l3_edit` 改的就是它；可能尚不存在 = 本轮首次提议，等于以 live 播种）
CursorPath: {{cursorPath}}
SceneDir: {{sceneDir}}
IndexPath: {{indexPath}}
PromptDir: {{promptDir}}
PromptFile: {{promptFile}}
ChangedScenes: {{changedScenes}}
TriggerReason: {{triggerReason}}
Mode: {{mode}}
CharLimit: {{charLimit}}  （画像全篇字符上限，按「并入 USER.md 后的整篇」计价，代码硬校验：超出会被 l3_edit 拒绝）
EntryCharLimit: {{entryCharLimit}}  （单条规则字符上限，一次 l3_edit 只能写一条）
