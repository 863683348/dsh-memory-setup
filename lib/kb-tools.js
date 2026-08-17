/**
 * dsh-memory-setup — knowledge-base tools (registered by index.js).
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { kbAdd, kbSearchBM25, kbList, kbRemove, kbHit, kbSummary, renderKB, embeddingSearch } from "./knowledge.js";

/** Fetch an embedding from an OpenAI-compatible endpoint. Runtime-only. */
async function embed(text, config) {
  const res = await fetch(config.embeddingEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.embeddingKey ? { Authorization: "Bearer " + config.embeddingKey } : {}),
    },
    body: JSON.stringify({ input: text, model: config.embeddingModel || "text-embedding-3-small" }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error("embed HTTP " + res.status);
  const j = await res.json();
  const vec = j?.data?.[0]?.embedding ?? j?.embeddings?.[0] ?? null;
  if (!Array.isArray(vec)) throw new Error("unexpected embedding response");
  return vec;
}

function embedTextOf(entry) {
  return (entry.title || "") + "\n" + (entry.content || "").slice(0, 2000) + "\n" + (entry.tags || []).join(", ");
}

/**
 * @param ctx the plugin context
 * @param storage { loadKB, saveKB } — fs-backed KB storage helpers
 * @param config plugin config (embedding fields)
 */
export function registerKnowledgeTools(ctx, storage, config = {}) {
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
      const limit = Math.max(1, Math.min(20, args.limit || 5));
      let results = null;
      if (config.embeddingEndpoint) {
        try {
          const queryVec = await embed(args.query, config);
          results = embeddingSearch(kb, queryVec, { limit });
          if (!results.length && kb.entries.some((e) => e.embedding)) {
            // query embedded but nothing above 0 — fall through to BM25
          }
        } catch { results = null; }
      }
      if (results === null || !results.length) {
        results = kbSearchBM25(kb, args.query, { limit });
      }
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

  ctx.tools.register(defineTool({
    name: "knowledge_embed",
    description: "为知识库条目生成 embeddings（需配置 embeddingEndpoint）；随后 knowledge_search 将使用语义检索。",
    parameters: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          embedded: { type: "number" },
          failed: { type: "number" },
          note: { type: "string" },
        },
      },
      render: (_a, v) => [{ type: "text", text: "embedded " + v.embedded + ", failed " + v.failed + (v.note ? ". " + v.note : "") }],
    },
    execute: async (args, exec) => {
      if (!config.embeddingEndpoint) {
        return { embedded: 0, failed: 0, note: "set embeddingEndpoint in plugin config to enable embeddings" };
      }
      const { kb, target } = await storage.loadKB(exec);
      let embedded = 0, failed = 0;
      for (const entry of kb.entries) {
        if (Array.isArray(entry.embedding)) continue;
        try {
          entry.embedding = await embed(embedTextOf(entry), config);
          embedded++;
        } catch { failed++; }
      }
      if (embedded) {
        kb.updatedAt = new Date().toISOString();
        await storage.saveKB(exec, target, kb);
      }
      return { embedded, failed, note: config.embeddingEndpoint };
    },
    presentCall: (args) => ({ card: "generic", title: "生成向量", kind: "other", rawInput: args }),
  }));
}
