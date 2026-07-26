import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MemoryManager,
} from "./memory/index.js";
import {
  SkillManager,
  setBundledSkillsPaths,
} from "./skill/index.js";
import { setupMemoryReviewer } from "./memory/reviewer.js";
import { setupSkillReviewer } from "./skill/reviewer.js";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const manager = new MemoryManager(agentDir);
  let skillManager: SkillManager | undefined;
  let profileSkillsPath: string | undefined;
  let loadedSkillsThisSession: Set<string> = new Set();

  // 提供懒引用给 reviewer，避免循环依赖
  let getMemoryStatus: () => string = () => "0t";
  let getSkillStatus: () => string = () => "0t";



  // ── Resource Discovery ──────────────────────────────────────

  pi.on("resources_discover", () => {
    if (!profileSkillsPath) return {};
    const skillsDir = resolve(profileSkillsPath, "skills");
    if (!existsSync(skillsDir)) return {};
    return { skillPaths: [skillsDir] };
  });

  // ── Session Lifecycle ───────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    manager.initialize();
    const profile = manager.getProfileManager().getActiveProfile();
    skillManager = new SkillManager(profile.path, [
      resolve(agentDir, "skills"),
    ]);
    profileSkillsPath = profile.path;
    setBundledSkillsPaths(
      [resolve(process.cwd(), ".pi", "skills")].filter((p) => existsSync(p)),
    );
    loadedSkillsThisSession = new Set();

    // 初始化审查子代理调度器（单次注册）
    getMemoryStatus = setupMemoryReviewer(pi, () => manager);
    getSkillStatus = setupSkillReviewer(pi, () => skillManager, () => loadedSkillsThisSession);

    ctx.ui.setStatus("memory", `Memory ${getMemoryStatus()} | Skill ${getSkillStatus()}`);

    // Wire up LLM filter for inverted index (async, non-blocking)
    const currentModel = ctx.model;
    manager.invertedIndexInstance.setLLMFilter(async (prompt: string) => {
      try {
        const result = await completeSimple(currentModel, {
          systemPrompt: "You respond only with JSON.",
          messages: [{ role: "user", content: prompt }],
        });
        return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      } catch {
        return "";
      }
    });
  });

  pi.on("session_shutdown", async () => {
    manager.shutdown();
    skillManager = undefined;
    profileSkillsPath = undefined;
  });

  // ── 状态显示 ────────────────────────────────────────────────

  pi.on("agent_settled", async (_event, ctx) => {
    ctx.ui.setStatus("memory", `Memory ${getMemoryStatus()} | Skill ${getSkillStatus()}`);
  });

  // ── Context Injection ───────────────────────────────────────

  const MEMORY_TOOL_REMINDER =
    "\n\n[Memory] You have persistent memory across sessions. Save durable facts using the memory " +
    "tool. Memory is injected into every turn, so keep entries compact and high-signal.\n" +
    "For classification rules (auto-write / confirm-write / staging / size thresholds / target boundaries), " +
    "read 记忆分类框架.md from profile root.\n" +
    "Do NOT save task progress, session outcomes, or temporary TODO state to memory.\n" +
    "When you complete a complex task or discover a non-trivial pattern, " +
    "save the approach as a skill with skill_manage. " +
    "When a loaded skill is outdated or wrong, patch it immediately with skill_manage(edit).\n" +
    "\n[Protected Files] C:\\Users\\leaf\\.pi\\agent\\agents\\*.md (memory-reviewer, skill-reviewer, memory-organizer) " +
    "are protected. ONLY use edit, NEVER write on these files.";

  pi.on("before_agent_start", async (event, ctx) => {
    // Build combined query: current user input + recent conversation history
    let queryText = event.prompt;
    try {
      const entries = ctx.sessionManager.getEntries();
      const recentMessages = entries
        .filter((e: any) => e.type === "message")
        .slice(-10)
        .map((e: any) => {
          const content = e.message?.content;
          if (typeof content === "string") return `[${e.message?.role}] ${content}`;
          if (Array.isArray(content)) {
            return content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join(" ");
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      if (recentMessages) {
        queryText = `${event.prompt}\n${recentMessages}`;
      }
    } catch {
      // sessionManager not available, fall back to prompt only
    }

    const memoryContext = manager.prefetchAll(queryText, ctx.cwd);
    if (memoryContext) {
      event.systemPrompt += `\n\n${memoryContext}`;
    }
    event.systemPrompt += MEMORY_TOOL_REMINDER;
    const skillRefs = event.prompt.match(/<skill\s+name="([^"]+)"/g) || [];
    for (const ref of skillRefs) {
      const name = ref.match(/name="([^"]+)"/);
      if (name) loadedSkillsThisSession.add(name[1]);
    }
    const skillPlaceholders = event.prompt.match(/\[skill:\s*([^\]]+)\]/g) || [];
    for (const ref of skillPlaceholders) {
      const name = ref.match(/\[skill:\s*([^\]]+)\]/);
      if (name) loadedSkillsThisSession.add(name[1].trim());
    }

    // 必须 return 修改后的 systemPrompt，否则 pi 丢弃所有变更
    return { systemPrompt: event.systemPrompt };
  });

  // ── Memory Tool ─────────────────────────────────────────────

  pi.registerTool({
    name: "memory",
    label: "Memory",
    description:
      "WRITE TO PERSISTENT MEMORY. Use the CORRECT target.\n" +
      "  1. User preference/habit → target='user'\n" +
      "  2. Global env fact → target='memory'\n" +
      "  3. Project-specific info → target='sub-memory', path='{category}/{name}.md'\n" +
      "  4. Workflow → create a skill, not memory\n" +
      "RULE: project path in message = sub-memory, NOT memory/user.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "replace", "remove"],
          description: "The operation to perform. Omit when using 'operations' for batch.",
        },
        target: {
          type: "string",
          enum: ["memory", "user", "sub-memory"],
          description:
            "CRITICAL — wrong target = routing system can never load it.\n" +
            "  'user'        = user attributes (preference, habit, role, style)\n" +
            "  'memory'      = global env facts (encoding, OS, universal paths)\n" +
            "  'sub-memory'  = project-specific (requires path param: '{category}/{name}.md')\n" +
            "项目路径/端口/版本/配置 -> sub-memory | 用户偏好 -> user | 全局常量 -> memory",
        },
        content: { type: "string", description: "Entry content for add/replace." },
        path: {
          type: "string",
          description:
            "REQUIRED for target='sub-memory': relative path under sub-memories/, " +
            "e.g. 'wangxin/A104527-java8-setup.md'.",
        },
        old_text: {
          type: "string",
          description: "Substring identifying the entry for replace/remove.",
        },
        operations: {
          type: "array",
          description: "Batch of operations applied atomically. Preferred for multiple changes.",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add", "replace", "remove"] },
              content: { type: "string" },
              old_text: { type: "string" },
            },
            required: ["action"],
          },
        },
      },
      required: ["target"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!manager) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Memory system not initialized." }) }], details: {} };
      }
      const result = manager.handleToolCall("memory", params as Record<string, unknown>);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ── Skill Manage Tool ───────────────────────────────────────

  pi.registerTool({
    name: "skill_manage",
    label: "Skill Manage",
    description:
      "Manage skills (create, edit, delete, list). Skills are your procedural " +
      "memory — reusable approaches for recurring task types. " +
      "General memory (MEMORY.md / USER.md) is broad and declarative; skills are " +
      "narrow and actionable.\n\n" +
      "Create when: complex task succeeded (5+ calls), errors overcome, " +
      "user-corrected approach worked, non-trivial workflow discovered.\n" +
      "Update when: instructions stale/wrong, missing steps or pitfalls found " +
      "during use. If you used a skill and hit issues not covered by it, patch it immediately.\n\n" +
      "New skills go to profiles/<active>/skills/<category>/<name>/SKILL.md. Existing skills " +
      "can be modified wherever they live.\n\n" +
      "Pinned skills are protected from deletion only — edit and write_file still work. " +
      "Unpin first to delete. Bundled skills (system-level) cannot be modified at all.\n\n" +
      "Good skills include: concrete trigger conditions (When to Use), numbered steps " +
      "with exact commands, a pitfalls section, and verification steps. " +
      "Use skill_view() to see format examples.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "edit", "delete", "list", "write_file", "pin", "unpin"],
          description: "The operation to perform.",
        },
        name: {
          type: "string",
          description: "Skill name (lowercase-hyphenated, <=64 chars). Required for create/edit/delete/write_file.",
        },
        category: {
          type: "string",
          description: "Category folder (e.g. 'workflow', 'tool'). Required for create.",
        },
        content: {
          type: "string",
          description: "Full SKILL.md content for create/edit. Must include frontmatter and body sections.",
        },
        file_path: {
          type: "string",
          description: "Support file path for write_file. Must start with 'references/', 'templates/', or 'scripts/'.",
        },
      },
      required: ["action"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!skillManager) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Skill manager not initialized." }) }], details: {} };
      }
      const { handleSkillManageTool } = await import("./skill/skill-tool.js");
      const result = handleSkillManageTool(params as Record<string, unknown>, skillManager);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ── Skill View Tool ─────────────────────────────────────────

  pi.registerTool({
    name: "skill_view",
    label: "Skill View",
    description: "View the content of a skill's SKILL.md or support files. Use this to inspect a skill before deciding whether to update it.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name (e.g. 'git-commit')." },
        file_path: { type: "string", description: "Optional: path to a support file (e.g. 'references/api.md')." },
      },
      required: ["name"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!skillManager) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Skill manager not initialized." }) }], details: {} };
      }
      const { handleSkillViewTool } = await import("./skill/skill-view-tool.js");
      const result = handleSkillViewTool(params as Record<string, unknown>, skillManager);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ── /profile Command ────────────────────────────────────────

  pi.registerCommand("profile", {
    description: "List or switch memory profiles. Usage: /profile [list|switch <name>]",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const sub = parts[0];

      if (sub === "list" || !sub) {
        const profiles = manager.listProfiles();
        const active = manager.activeProfile;
        const lines = profiles.map((p) => p.name === active ? `* ${p.name} (active)` : `  ${p.name}`);
        ctx.ui.notify(`Profiles:\n${lines.join("\n")}`, "info");
        return;
      }

      if (sub === "switch" && parts[1]) {
        try {
          manager.switchProfile(parts[1]);
          const profile = manager.getProfileManager().getActiveProfile();
          skillManager = new SkillManager(profile.path);
          ctx.ui.notify(`Switched to profile: ${parts[1]}`, "info");
        } catch (e) {
          ctx.ui.notify(`Failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        return;
      }

      ctx.ui.notify("Usage: /profile [list|switch <name>]", "info");
    },
  });

  // ── /rebuild-index Command ─────────────────────────────────

  pi.registerCommand("rebuild-index", {
    description: "Rebuild inverted index from all memory files (deletes old index). Usage: /rebuild-index",
    handler: async (_args, ctx) => {
      const profile = manager.getProfileManager().getActiveProfile();
      const index = manager.invertedIndexInstance;

      const entries: Array<{ filePath: string; content: string }> = [];

      // MEMORY.md + USER.md
      for (const name of ["MEMORY.md", "USER.md"]) {
        const fp = join(profile.path, name);
        if (existsSync(fp)) {
          entries.push({ filePath: name, content: readFileSync(fp, "utf-8") });
        }
      }

      // sub-memories/ (递归)
      const subDir = join(profile.path, "sub-memories");
      if (existsSync(subDir)) {
        const walk = (dir: string, prefix: string) => {
          for (const item of readdirSync(dir)) {
            const full = join(dir, item);
            const s = statSync(full);
            if (s.isDirectory()) {
              walk(full, `${prefix}${item}/`);
            } else if (item.endsWith(".md")) {
              entries.push({ filePath: `sub-memories/${prefix}${item}`, content: readFileSync(full, "utf-8") });
            }
          }
        };
        walk(subDir, "");
      }

      index.rebuild(entries);
      ctx.ui.notify(`倒排索引已重建：${entries.length} 个文件，${index.size} 个关键词`, "info");
    },
  });
}

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

function getAgentDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || process.env.HOMEDRIVE + process.env.HOMEPATH || "";
  return process.env.PI_CODING_AGENT_DIR || `${home}/.pi/agent`;
}
