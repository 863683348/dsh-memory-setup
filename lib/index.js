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
  renderMemory, memorySummary, pruneMemory, applyReview, applyReviews, exportMarkdown,
  diffMemory, renderDiff, findLessonFix, snapshotId, pruneSnapshots,
  promoteLessons, computeStats, renderStats,
} from "./memory.js";
import { kbSearchBM25 } from "./knowledge.js";
import { extractConventions } from "./scanner.js";
import { isValidKnowledge } from "./knowledge.js";
import { registerKnowledgeTools } from "./kb-tools.js";

const name = "dsh-memory-setup";
const inject = ["tools", "fs", "systemPrompt", "workspace"];

const Config = z.object({
  /** Memory directory, relative to the session workspace. */
  memoryDir: z.string().default(".dsh-memory-setup"),
  /** Add the memory guidance section to the system prompt at boot. */
  injectOnBoot: z.boolean().default(true),
  /** Cap for rendered memory text. */
  maxMemoryChars: z.number().default(6000),
  /** Lessons expire after this many days (pruned on save). 0 disables expiry. */
  lessonTtlDays: z.number().default(90),
  /** Keep at most this many changelog entries. */
  changelogCap: z.number().default(100),
  /** Write memory.json.bak before every save (crash/tamper recovery). */
  backupOnSave: z.boolean().default(true),
  /** Append a self-review reminder to the injected guidance. */
  reviewReminder: z.boolean().default(true),
  /** Optional OpenAI-compatible embeddings endpoint (v0.5). Empty = BM25 only. */
  embeddingEndpoint: z.string().default(""),
  /** Bearer key for the embeddings endpoint. */
  embeddingKey: z.string().default(""),
  /** Embeddings model name. */
  embeddingModel: z.string().default("text-embedding-3-small"),
  /** Keep at most this many memory snapshots. */
  snapshotKeep: z.number().default(10),
  /** Append a troubleshoot reminder to the injected guidance. */
  troubleshootReminder: z.boolean().default(true),
  /** Auto-promote recurring lessons (hits >= threshold) into conventions on save. */
  autoPromote: z.boolean().default(true),
  /** Hit threshold for lesson promotion. */
  promoteHitThreshold: z.number().default(3),
});

function apply(ctx, config) {
  const dirName = config.memoryDir || ".dsh-memory-setup";

  const memoryRel = (file) => join(dirName, file);
  const kbRel = (file) => join(dirName, file);
  const cwdOf = (exec) => exec.agent?.session?.header?.cwd;

  const STATIC_GUIDANCE =
    "A personal memory lives in the session workspace at .dsh-memory-setup/memory.json. " +
    "At the start of meaningful work read it (memory_status) and follow your preferences, conventions, workflows and lessons. " +
    "Record new conventions with memory_project, formalize failures with memory_review, and consult your knowledge base with knowledge_search." +
    (config.reviewReminder
      ? " At the end of a long task, run memory_review for anything that failed and knowledge_add for useful new facts."
      : "") +
    (config.troubleshootReminder
      ? " When a tool or command fails, run memory_troubleshoot with the error text — it checks past lessons and knowledge for a known fix. Snapshot your memory before big changes with memory_snapshot."
      : "");
  /** Mutable context object — dsh-system-prompt renders its .text live per request. */
  const memCtx = { name: "memory:content", order: 500, text: STATIC_GUIDANCE };
  let lastContextRefresh = 0;

  let fsFailures = 0;
  async function loadJsonFor(rel, cwd, signal) {
    try {
      const target = await ctx.fs.resolve(rel, { cwd, ...(signal ? { signal } : {}) });
      const info = await ctx.fs.stat(target, signal).catch(() => undefined);
      if (!info || info.type !== "file") return { doc: null, target };
      const text = await ctx.fs.readText(target, signal);
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      return { doc: parsed, target };
    } catch (err) {
      fsFailures++;
      if (fsFailures >= 3 && !memCtx.text.includes("⚠️")) {
        memCtx.text += "\n\n⚠️ The memory plugin is hitting filesystem errors (" + fsFailures + "x). Check workspace permissions and the .dsh-memory-setup/ state.";
      }
      throw err;
    }
  }

  /** Refresh the injected context text with the current memory (throttled). */
  async function refreshMemoryContext(cwd) {
    if (!cwd) return;
    const now = Date.now();
    if (now - lastContextRefresh < 30000) return;
    lastContextRefresh = now;
    try {
      const { doc } = await loadJsonFor(memoryRel("memory.json"), cwd);
      const body = renderMemory(isValidMemory(doc) ? doc : emptyMemory(), config.maxMemoryChars);
      memCtx.text = STATIC_GUIDANCE + (body ? "\n\nCurrent personal memory:\n" + body : "");
    } catch { /* keep static guidance */ }
  }

  async function loadDoc(exec) {
    const { doc, target } = await loadJsonFor(memoryRel("memory.json"), cwdOf(exec), exec.signal);
    return { doc: isValidMemory(doc) ? doc : emptyMemory(), target };
  }

  async function saveDoc(exec, target, doc) {
    const promotedDoc = config.autoPromote ? promoteLessons(doc, { hitThreshold: config.promoteHitThreshold }).doc : doc;
    const pruned = pruneMemory(promotedDoc, { changelogCap: config.changelogCap, lessonTtlDays: config.lessonTtlDays });
    if (config.backupOnSave) {
      const bak = await ctx.fs.resolve(memoryRel("memory.json.bak"), { cwd: cwdOf(exec), signal: exec.signal });
      const info = await ctx.fs.stat(target, exec.signal).catch(() => undefined);
      if (info && info.type === "file") {
        const text = await ctx.fs.readText(target, exec.signal);
        await ctx.fs.writeText(bak, text, undefined, exec.signal).catch(() => {});
      }
    }
    await ctx.fs.writeText(target, JSON.stringify(pruned, null, 2) + "\n", undefined, exec.signal);
    refreshMemoryContext(cwdOf(exec)).catch(() => {});
    return pruned;
  }

  async function loadKB(exec) {
    const { doc, target } = await loadJsonFor(kbRel("knowledge.json"), cwdOf(exec), exec.signal);
    return { kb: isValidKnowledge(doc) ? doc : emptyKnowledge(), target };
  }
  async function saveKB(exec, target, kb) {
    await ctx.fs.writeText(target, JSON.stringify(kb, null, 2) + "\n", undefined, exec.signal);
    return kb;
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
    ctx.effect(() => {
      const dispose = ctx.systemPrompt.context(memCtx);
      const bootCwd = ctx.workspace?.path;
      if (bootCwd) refreshMemoryContext(bootCwd).catch(() => {});
      return dispose;
    });
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
    name: "memory_review",
    description: "事故复盘：把一次失败形式化为教训（错误/根因/修复/证据）。重复的教训自动合并并累计命中次数（去重入库）。",
    parameters: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          error: { type: "string", required: true, description: "错误/问题描述" },
          fix: { type: "string", required: true, description: "正确做法/修复方案" },
          rootCause: { type: "string", description: "根因分析" },
          evidence: { type: "string", description: "证据（文件/命令/现象）" },
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
          deduped: { type: "boolean" },
          hits: { type: "number" },
        },
      },
      render: (_a, v) => [{ type: "text", text: (v.deduped ? "Merged into an existing lesson (hits " + v.hits + ").\n" : "Lesson recorded.\n") + v.markdown }],
    },
    execute: async (args, exec) => {
      const { doc, target } = await loadDoc(exec);
      const { doc: next, deduped, hits } = applyReview(doc, {
        error: args.error, fix: args.fix, rootCause: args.rootCause, evidence: args.evidence,
      });
      const saved = await saveDoc(exec, target, next);
      return { summary: memorySummary(saved), markdown: renderMemory(saved, config.maxMemoryChars), deduped, hits };
    },
    presentCall: (args) => ({ card: "generic", title: "事故复盘", kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "memory_export",
    description: "把完整记忆（含 changelog）导出为工作区内的 Markdown 文件，便于人工审阅/备份。",
    parameters: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          includeChangelog: { type: "boolean", description: "是否包含变更日志（默认 true）" },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          preview: { type: "string" },
        },
      },
      render: (_a, v) => [{ type: "text", text: "Exported to " + v.path + "\n" + v.preview }],
    },
    execute: async (args, exec) => {
      const cwd = cwdOf(exec);
      const { doc } = await loadDoc(exec);
      const md = exportMarkdown(doc, { includeChangelog: args.includeChangelog !== false });
      const rel = memoryRel("memory-export.md");
      const target = await ctx.fs.resolve(rel, { cwd, signal: exec.signal });
      await ctx.fs.writeText(target, md + "\n", undefined, exec.signal);
      return { path: rel, preview: md.slice(0, 400) };
    },
    presentCall: (args) => ({ card: "generic", title: "导出记忆", kind: "other", rawInput: args }),
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

  ctx.tools.register(defineTool({
    name: "memory_diff",
    description: "对比当前记忆与备份（memory.json.bak）的差异，输出变更清单；可选写入 memory-diff.md。",
    parameters: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          write: { type: "boolean", description: "是否把差异写入 memory-diff.md（默认 false）" },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          count: { type: "number" },
          diff: { type: "string" },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.diff }],
    },
    execute: async (args, exec) => {
      const cwd = cwdOf(exec);
      const cur = await loadDoc(exec);
      const bak = await loadJsonFor(memoryRel("memory.json.bak"), cwd, exec.signal);
      const prev = isValidMemory(bak.doc) ? bak.doc : emptyMemory();
      const changes = diffMemory(prev, cur.doc);
      const md = renderDiff(changes);
      if (args.write) {
        const target = await ctx.fs.resolve(memoryRel("memory-diff.md"), { cwd, signal: exec.signal });
        await ctx.fs.writeText(target, "# Memory diff\n\n" + md + "\n", undefined, exec.signal);
      }
      return { count: changes.length, diff: md };
    },
    presentCall: (args) => ({ card: "generic", title: "记忆差异", kind: "other", rawInput: args }),
  }));



  ctx.tools.register(defineTool({
    name: "memory_snapshot",
    description: "保存当前记忆快照（含 changelog），可用于后续回滚。最多保留 snapshotKeep 个。",
    parameters: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          note: { type: "string", description: "快照说明（如 before refactor）" },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          kept: { type: "number" },
        },
      },
      render: (_a, v) => [{ type: "text", text: "snapshot " + v.id + " (kept " + v.kept + ")" }],
    },
    execute: async (args, exec) => {
      const cwd = cwdOf(exec);
      const { doc } = await loadDoc(exec);
      const { kb } = await loadKB(exec);
      const id = snapshotId();
      const snapTarget = await ctx.fs.resolve(memoryRel("snapshots/" + id + ".json"), { cwd, signal: exec.signal });
      const payload = { id, ts: new Date().toISOString(), note: args.note || "", doc, kb };
      await ctx.fs.writeText(snapTarget, JSON.stringify(payload, null, 2) + "\n", undefined, exec.signal);
      const idxTarget = await ctx.fs.resolve(memoryRel("snapshots.json"), { cwd, signal: exec.signal });
      const idx = await loadJsonFor(memoryRel("snapshots.json"), cwd, exec.signal);
      const list = pruneSnapshots([...(Array.isArray(idx.doc) ? idx.doc : []), { id, ts: payload.ts, file: "snapshots/" + id + ".json", note: args.note || "" }], config.snapshotKeep);
      await ctx.fs.writeText(idxTarget, JSON.stringify(list, null, 2) + "\n", undefined, exec.signal);
      return { id, kept: list.length };
    },
    presentCall: (args) => ({ card: "generic", title: "保存快照", kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "memory_list_snapshots",
    description: "列出全部记忆快照（id/时间/说明）。",
    parameters: {
      input: { type: "object", additionalProperties: false, properties: {} },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          count: { type: "number" },
          list: { type: "string" },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.list }],
    },
    execute: async (args, exec) => {
      const cwd = cwdOf(exec);
      const idx = await loadJsonFor(memoryRel("snapshots.json"), cwd, exec.signal);
      const list = Array.isArray(idx.doc) ? idx.doc : [];
      const md = list.length ? list.map((s) => "- " + s.id + "  " + (s.ts || "") + (s.note ? "  (" + s.note + ")" : "")).join("\n") : "(no snapshots yet)";
      return { count: list.length, list: md };
    },
    presentCall: (args) => ({ card: "generic", title: "快照列表", kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "memory_restore",
    description: "从快照恢复记忆（当前记忆先备份为 memory.json.bak）。",
    parameters: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true, description: "快照 id（见 memory_list_snapshots）" },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          restored: { type: "boolean" },
          summary: { type: "object", additionalProperties: false },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.restored ? "Restored." : "Snapshot not found." }],
    },
    execute: async (args, exec) => {
      const cwd = cwdOf(exec);
      const snap = await loadJsonFor(memoryRel("snapshots/" + args.id + ".json"), cwd, exec.signal);
      const payload = snap.doc || null;
      const doc = payload && isValidMemory(payload.doc) ? payload.doc : null;
      if (!doc) return { restored: false, summary: memorySummary(emptyMemory()) };
      const cur = await loadDoc(exec);
      const restored = await saveDoc(exec, cur.target, doc);
      if (payload && isValidKnowledge(payload.kb)) {
        const kbCur = await loadKB(exec);
        await saveKB(exec, kbCur.target, payload.kb);
      }
      return { restored: true, summary: memorySummary(restored) };
    },
    presentCall: (args) => ({ card: "generic", title: "恢复快照", kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "memory_troubleshoot",
    description: "故障排查：给定错误信息，检索历史教训与知识库，返回已知修复建议。",
    parameters: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          error: { type: "string", required: true, description: "错误信息/现象" },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          lessonFix: { type: "string" },
          knowledgeHits: { type: "array", items: { type: "object", additionalProperties: false } },
          suggestion: { type: "string" },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.suggestion }],
    },
    execute: async (args, exec) => {
      const { doc } = await loadDoc(exec);
      const { kb } = await loadKB(exec);
      const hit = findLessonFix(doc, args.error);
      const kHits = kbSearchBM25(kb, args.error, { limit: 3 });
      const lines = [];
      if (hit) lines.push("Known fix from past lesson: " + hit.fix + (hit.evidence ? " (evidence: " + hit.evidence + ")" : ""));
      else lines.push("No matching lesson yet — run memory_review to record this failure.");
      if (kHits.length) {
        lines.push("Related knowledge:");
        for (const k of kHits) lines.push("  - " + k.title + (k.score != null ? " (" + k.score + ")" : ""));
      }
      return { lessonFix: hit ? hit.fix : "", knowledgeHits: kHits.map((k) => ({ title: k.title, score: k.score })), suggestion: lines.join("\n") };
    },
    presentCall: (args) => ({ card: "generic", title: "故障排查", kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "memory_stats",
    description: "记忆与知识库统计：条目数、教训命中、高频教训、快照数、变更日志等。",
    parameters: {
      input: { type: "object", additionalProperties: false, properties: {} },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          stats: { type: "object", additionalProperties: false },
          markdown: { type: "string" },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.markdown }],
    },
    execute: async (args, exec) => {
      const cwd = cwdOf(exec);
      const { doc } = await loadDoc(exec);
      const { kb } = await loadKB(exec);
      const idx = await loadJsonFor(memoryRel("snapshots.json"), cwd, exec.signal);
      const stats = computeStats(doc, kb, Array.isArray(idx.doc) ? idx.doc : []);
      return { stats, markdown: renderStats(stats) };
    },
    presentCall: (args) => ({ card: "generic", title: "记忆统计", kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "memory_promote",
    description: "把高频教训（命中 >= promoteHitThreshold）晋升为长期约定，让记忆从错误中学习。",
    parameters: {
      input: { type: "object", additionalProperties: false, properties: {} },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          promoted: { type: "number" },
          markdown: { type: "string" },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.markdown }],
    },
    execute: async (args, exec) => {
      const { doc, target } = await loadDoc(exec);
      const { doc: next, promoted } = promoteLessons(doc, { hitThreshold: config.promoteHitThreshold });
      if (promoted.length) await saveDoc(exec, target, next);
      const md = promoted.length ? "Promoted " + promoted.length + " lesson(s):\n" + promoted.map((p) => "- " + p.detail).join("\n") : "No lessons reached the hit threshold (" + config.promoteHitThreshold + ").";
      return { promoted: promoted.length, markdown: md };
    },
    presentCall: (args) => ({ card: "generic", title: "晋升教训", kind: "other", rawInput: args }),
  }));
  ctx.tools.register(defineTool({
    name: "memory_review_session",
    description: "批量事故复盘：一次提交多条失败事件（error/fix/rootCause/evidence），自动去重入库。",
    parameters: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          incidents: {
            type: "array",
            items: { type: "object", additionalProperties: false, properties: {
              error: { type: "string", description: "错误描述" },
              fix: { type: "string", description: "修复方案" },
              rootCause: { type: "string", description: "根因" },
              evidence: { type: "string", description: "证据" },
            } },
            description: "失败事件列表"
          },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          added: { type: "number" },
          merged: { type: "number" },
          summary: { type: "object", additionalProperties: false },
        },
      },
      render: (_a, v) => [{ type: "text", text: "added " + v.added + ", merged " + v.merged + " lessons." }],
    },
    execute: async (args, exec) => {
      const { doc, target } = await loadDoc(exec);
      const { doc: next, added, merged } = applyReviews(doc, args.incidents);
      const saved = await saveDoc(exec, target, next);
      return { added, merged, summary: memorySummary(saved) };
    },
    presentCall: (args) => ({ card: "generic", title: "批量复盘", kind: "other", rawInput: args }),
  }));

  registerKnowledgeTools(ctx, { loadKB, saveKB }, config);
}

export { Config, apply, inject, name };
