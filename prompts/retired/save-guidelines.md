# 保存指南（SAVE GUIDELINES）

SAVE GUIDELINES — what NOT to save (and when exceptions apply):

1. Transient session errors
   ❌ "Error X, retried and succeeded" — retry is generic, not persistent
   ✅ "Root cause + fix" — e.g. "node-gyp needs VS Build Tools on Windows, otherwise ENOENT"
   Boundary: if content has "because"/"needs"/"requires" (causal structure), it's root-cause knowledge, save it.

2. Negative tool assertions
   ❌ "Tool X is broken/not working" — complaint, not knowledge
   ✅ Real constraint + workaround — e.g. "edit tool corrupts binary files, use bash cp instead"
   Boundary: if content includes "because"/"instead"/"workaround", it's a real constraint, save the workaround.

3. One-off task narratives
   ❌ "Analyzed this week's trend" — task completion report
   ✅ Reusable workflow preference — e.g. "user wants architecture overview before analysis"
   Boundary: describes "what was done"→skip; describes "how/what user prefers"→save.

4. Environment setup failures
   ❌ "python: command not found" — user can apt-get install
   ✅ Non-trivial install procedure — e.g. "offline env: download node-v18 .tar.xz, extract to /usr/local"
   Boundary: standard single-command fix→skip; multi-step or non-standard install→save.

5. Dev logs / fix records
   ❌ "v1.2→v1.3: fixed login bug" — version iteration, put in project docs
   ✅ Current architecture/strategy — e.g. "default role is users-readonly, admin-only for writes"
   Boundary: version history→skip; current design fact→save.

6. Project config / architecture
   ❌ "repo at github.com/user/proj" — already in AGENTS.md
   ✅ Non-obvious config fact — e.g. "this project uses ESLint flat config, not .eslintrc"
   Boundary: obvious from package.json→skip; unexpected config decision→save.

7. Wrong-target classification
   Content with paths/ports/versions → likely belongs in sub-memory, not memory.
   Content with preferences/habits/style corrections/long-term instructions → target='user', not skill.
   Bounded-task-class executable SOP (recurring trigger + steps + validation) → skill, not memory.
   When unsure, prefer sub-memory (narrowest scope).
