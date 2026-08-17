/**
 * dsh-memory-setup — knowledge-base tools (registered by index.js).
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { kbAdd, kbSearchBM25, kbList, kbRemove, kbHit, kbSummary, renderKB } from "./knowledge.js";

/**
 * @param ctx the plugin context
 * @param storage { loadKB, saveKB } — fs-backed KB storage helpers
 */
export function registerKnowledgeTools(ctx, storage) {
  ctx.tools.register(defineTool({
    name: "knowledge_add",
    description: "向个人知识库添加一条知识（标题/内容/标签/来源）。标题相似（>=0.7）的条目自动合并更新。",
    parameters: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", required: true, description: "知识标题" },
          content: { type: "string", required: true, description: "知识内容" },
          tags: { type: "array", items: { type: "string" }, description: "标签列表" },
          source: { type: "string", description: "来源（文件/链接）" },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "object", additionalProperties: false },
          deduped: { type: "boolean" },
          entry: { type: "object", additionalProperties: false },
        },
      },
      render: (_a, v) => [{ type: "text", text: (v.deduped ? "Merged into existing entry. " : "Added. ") + JSON.stringify(v.entry) }],
    },
    execute: async (args, exec) => {
      const { kb, target } = await storage.loadKB(exec);
      const { kb: next, entry, deduped } = kbAdd(kb, { title: args.title, content: args.content, tags: args.tags, source: args.source });
      await storage.saveKB(exec, target, next);
      return { summary: kbSummary(next), deduped, entry };
    },
    presentCall: (args) => ({ card: "generic", title: "添加知识", kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "knowledge_search",
    description: "在个人知识库中检索知识（标题 x3 / 标签 x2 / 内容 x1 关键词打分），返回带分数的结果。",
    parameters: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", required: true, description: "检索关键词" },
          limit: { type: "number", description: "结果数量 1-20，默认 5" },
        },
      },
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
      const { kb, target } = await storage.loadKB(exec);
      const results = kbSearchBM25(kb, args.query, { limit: Math.max(1, Math.min(20, args.limit || 5)) });
      if (results.length) {
        const next = kbHit(kb, results[0].id);
        await storage.saveKB(exec, target, next);
      }
      return { count: results.length, list: renderKB(results, { detail: false }) };
    },
    presentCall: (args) => ({ card: "generic", title: "检索知识库", kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "knowledge_list",
    description: "列出个人知识库全部条目（按更新时间倒序）。",
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
          summary: { type: "object", additionalProperties: false },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.list }],
    },
    execute: async (args, exec) => {
      const { kb } = await storage.loadKB(exec);
      return { count: kb.entries.length, list: renderKB(kbList(kb), { detail: false }), summary: kbSummary(kb) };
    },
    presentCall: (args) => ({ card: "generic", title: "知识库列表", kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "knowledge_remove",
    description: "从个人知识库删除一条知识。",
    parameters: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true, description: "条目 id（见 knowledge_list）" },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          removed: { type: "boolean" },
          summary: { type: "object", additionalProperties: false },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.removed ? "Removed." : "Not found." }],
    },
    execute: async (args, exec) => {
      const { kb, target } = await storage.loadKB(exec);
      const { kb: next, removed } = kbRemove(kb, args.id);
      if (removed) await storage.saveKB(exec, target, next);
      return { removed, summary: kbSummary(next) };
    },
    presentCall: (args) => ({ card: "generic", title: "删除知识", kind: "other", rawInput: args }),
  }));
}
