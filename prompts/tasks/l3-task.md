---
vars: profilePath, userMdPath, cursorPath, sceneDir, indexPath, promptDir, promptFile, changedScenes, triggerReason, mode, charLimit, entryCharLimit
---
L3 persona generation task
ProfilePath: {{profilePath}}
UserMdPath: {{userMdPath}}
CursorPath: {{cursorPath}}
SceneDir: {{sceneDir}}
IndexPath: {{indexPath}}
PromptDir: {{promptDir}}
PromptFile: {{promptFile}}
ChangedScenes: {{changedScenes}}
TriggerReason: {{triggerReason}}
Mode: {{mode}}
CharLimit: {{charLimit}}  （USER.md 全篇字符上限，代码硬校验：超出会被 l3_edit 拒绝）
EntryCharLimit: {{entryCharLimit}}  （单条规则字符上限，一次 l3_edit 只能写一条）
