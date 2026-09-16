---
vars: recordsDir, sceneDir, indexPath, cursorPath, promptDir, mode, maxScenes, sceneCountWarning
---
L2 organization task
RecordsDir: {{recordsDir}}  （用 read_l1_increment 工具按需读取，不要直接 read 这个目录）
SceneDir: {{sceneDir}}
IndexPath: {{indexPath}}
CursorPath: {{cursorPath}}
PromptDir: {{promptDir}}
Mode: {{mode}}
MaxScenes: {{maxScenes}}  （场景块数量硬上限，规则文件中的 {maxScenes} 用此值替换）
SceneCountWarning: {{sceneCountWarning}}  （代码按当前块数算好的分级预警：红=已满禁 CREATE / 橙=差 1 个先进合并评估 / 黄=接近 / 无色=无额外限制）
