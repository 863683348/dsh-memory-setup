/**
 * dsh-memory-setup — Cordis plugin for DeepSeek Harness.
 * 解决 AI 的"金鱼脑"：偏好、项目约定、工作方式与纠错教训的本地可审计记忆层。
 *
 * Tools:
 *   memory_setup    — one-time onboarding: preferences, conventions, workflows
 *   memory_status   — read the current memory (also injected guidance at boot)
 *   memory_update   — update one memory path with a changelog entry
 *   memory_project  — auto-extract project conventions from workspace files
 *   memory_lesson   — record an error lesson (self-improvement hook)
 *
 * Storage: <workspace>/.dsh-memory-setup/memory.json — local, Markdown-readable,
 * every mutation logged to the changelog.
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { join } from "node:path";
import {
  emptyMemory, isValidMemory, applySetup, updateEntry, removeEntry, addLesson,
  renderMemory, memorySummary,
} from "./memory.js";
import { extractConventions } from "./scanner.js";

const name = "dsh-memory-setup";
const inject = ["tools", "fs", "systemPrompt"];

const Config = z.object({
  /** Memory directory, relative to the session workspace. */
  memoryDir: z.string().default(".dsh-memory-setup"),
  /** Add the memory guidance section to the system prompt at boot. */
  injectOnBoot: z.boolean().default(true),
  /** Cap for rendered memory text. */
  maxMemoryChars: z.number().default(6000),
});

function apply(ctx, config) {
  const dirName = config.memoryDir || ".dsh-memory-setup";

  const memoryRel = (file) => join(dirName, file);
  const cwdOf = (exec) => exec.agent?.session?.header?.cwd;

  async function loadDoc(exec) {
    const cwd = cwdOf(exec);
    const target = await ctx.fs.resolve(memoryRel("memory.json"), { cwd, signal: exec.signal });
    const info = await ctx.fs.stat(target, exec.signal).catch(() => undefined);
    if (!info || info.type !== "file") return { doc: emptyMemory(), target };
    const text = await ctx.fs.readText(target, exec.signal);
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { doc: isValidMemory(parsed) ? parsed : emptyMemory(), target };
  }

  async function saveDoc(exec, target, doc) {
    await ctx.fs.writeText(target, JSON.stringify(doc, null, 2) + "\n", undefined, exec.signal);
    return doc;
  }

  const wrap = (fn) => async (args, exec) => {
    const r = await fn(args, exec);
    const doc = r.doc;
    const md = renderMemory(doc, config.maxMemoryChars);
    return {
      summary: memorySummary(doc),
      markdown: md || "(memory is empty)",
      ...(r.extra || {}),
    };
  };

  if (config.injectOnBoot) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: "memory:setup",
        order: 500,
        text: "A personal memory lives in the session workspace at .dsh-memory-setup/memory.json. " +
          "At the start of meaningful work, call memory_status to read preferences, project conventions, workflows and lessons, " +
          "and follow them. Record new conventions with memory_project and new mistakes with memory_lesson.",
      }),
    );
  }

  ctx.tools.register(defineTool({
    name: "memory_setup",
    description: "一次性记忆设置：录入语言偏好、代码风格、常用工具、项目约定与常用工作流，写入本地记忆文件。",
    parameters: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          language: { type: "string", description: "常用语言/技术栈" },
          codeStyle: { type: "string", description: "代码风格约定（缩进/命名/注释）" },
          tools: { type: "string", description: "常用工具与命令" },
          notes: { type: "string", description: "其他偏好备注" },
          conventions: { type: "array", items: { type: "string" }, description: "项目约定列表" },
          workflows: { type: "array", items: { type: "string" }, description: "常用工作流名称列表" },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "object", additionalProperties: false },
          markdown: { type: "string" },
        },
      },
      render: (_a, v) => [{ type: "text", text: "Memory setup saved.\n" + v.markdown }],
    },
    execute: wrap(async (args, exec) => {
      const { doc, target } = await loadDoc(exec);
      const { doc: next, changes } = applySetup(doc, args);
      await saveDoc(exec, target, next);
      return { doc: next, extra: { changes: changes.length } };
    }),
    presentCall: (args) => ({ card: "generic", title: "记忆设置", kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "memory_status",
    description: "读取当前个人记忆（偏好/项目约定/工作流/教训）与变更日志。",
    parameters: {
      input: { type: "object", additionalProperties: false, properties: {} },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "object", additionalProperties: false },
          markdown: { type: "string" },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.markdown }],
    },
    execute: wrap(async (_args, exec) => {
      const { doc } = await loadDoc(exec);
      return { doc };
    }),
    presentCall: (args) => ({ card: "generic", title: "查看记忆", kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "memory_update",
    description: "更新一条记忆（路径如 preferences.codeStyle），记录 changelog。",
    parameters: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true, description: "记忆路径，如 preferences.codeStyle" },
          value: { type: "string", required: true, description: "新值（JSON 字符串或普通文本）" },
          note: { type: "string", description: "变更说明" },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "object", additionalProperties: false },
          markdown: { type: "string" },
        },
      },
      render: (_a, v) => [{ type: "text", text: "Updated.\n" + v.markdown }],
    },
    execute: wrap(async (args, exec) => {
      const { doc, target } = await loadDoc(exec);
      let value;
      try { value = JSON.parse(args.value); } catch { value = args.value; }
      const next = updateEntry(doc, args.path, value, args.note, undefined);
      await saveDoc(exec, target, next);
      return { doc: next };
    }),
    presentCall: (args) => ({ card: "generic", title: "更新记忆 " + args.path, kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "memory_project",
    description: "扫描工作区关键文件（README/package.json/配置等），提取项目约定并可选写入记忆。",
    parameters: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          apply: { type: "boolean", description: "是否把提取的约定写入记忆（默认 false 只预览）" },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "object", additionalProperties: false },
          markdown: { type: "string" },
          proposals: { type: "array", items: { type: "object", additionalProperties: false } },
          applied: { type: "number" },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.markdown }],
    },
    execute: async (args, exec) => {
      const cwd = cwdOf(exec);
      const candidates = ["package.json", "README.md", "README.zh.md", ".env.example", "tsconfig.json", "pyproject.toml", "requirements.txt", "Makefile"];
      const files = [];
      for (const rel of candidates) {
        try {
          const t = await ctx.fs.resolve(rel, { cwd, signal: exec.signal });
          const info = await ctx.fs.stat(t, exec.signal).catch(() => undefined);
          if (!info || info.type !== "file") continue;
          const text = await ctx.fs.readText(t, exec.signal);
          files.push({ path: rel, text });
        } catch { /* skip */ }
      }
      const proposals = extractConventions(files);
      let applied = 0;
      let doc;
      if (args.apply && proposals.length) {
        const { doc: d, target } = await loadDoc(exec);
        doc = d;
        for (const p of proposals) {
          const existing = doc.projectConventions.some((c) => c.pattern === p.pattern && c.detail === p.detail);
          if (!existing) {
            doc.projectConventions.push({ id: "c" + (doc.projectConventions.length + 1), type: "auto", pattern: p.pattern, detail: p.detail, evidence: p.evidence, createdAt: new Date().toISOString() });
            applied++;
          }
        }
        if (applied) {
          doc.updatedAt = new Date().toISOString();
          doc.changelog.push({ ts: new Date().toISOString(), action: "project-scan", path: "projectConventions", summary: applied + " auto convention(s)" });
          await saveDoc(exec, target, doc);
        }
      }
      const current = doc || (await loadDoc(exec)).doc;
      const lines = proposals.map((p, i) => (i + 1) + ". [" + p.pattern + "] " + p.detail + " (from " + p.evidence + ")");
      return {
        summary: memorySummary(current),
        markdown: (proposals.length ? "Proposed conventions:\n" + lines.join("\n") : "No conventions detected in workspace files.") + (applied ? "\nApplied " + applied + " convention(s)." : ""),
        proposals,
        applied,
      };
    },
    presentCall: (args) => ({ card: "generic", title: "项目约定扫描", kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "memory_lesson",
    description: "记录一条纠错教训（错误 -> 修复），附证据，避免以后重复犯同类错误。",
    parameters: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          error: { type: "string", required: true, description: "描述错误/问题" },
          fix: { type: "string", required: true, description: "正确做法/修复方案" },
          evidence: { type: "string", description: "证据（文件/命令/现象），建议附行级引用" },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "object", additionalProperties: false },
          markdown: { type: "string" },
        },
      },
      render: (_a, v) => [{ type: "text", text: "Lesson recorded.\n" + v.markdown }],
    },
    execute: wrap(async (args, exec) => {
      const { doc, target } = await loadDoc(exec);
      const { doc: next } = addLesson(doc, { error: args.error, fix: args.fix, evidence: args.evidence });
      await saveDoc(exec, target, next);
      return { doc: next };
    }),
    presentCall: (args) => ({ card: "generic", title: "记录教训", kind: "other", rawInput: args }),
  }));
}

export { Config, apply, inject, name };
