---
vars: recordsDir, sceneDir, indexPath, cursorPath, promptDir, mode, maxScenes
---
L2 organization task
RecordsDir: {{recordsDir}}  （用 read_l1_increment 工具按需读取，不要直接 read 这个目录）
SceneDir: {{sceneDir}}
IndexPath: {{indexPath}}
CursorPath: {{cursorPath}}
PromptDir: {{promptDir}}
Mode: {{mode}}
MaxScenes: {{maxScenes}}  （场景块数量硬上限，规则文件中的 {maxScenes} 用此值替换）
