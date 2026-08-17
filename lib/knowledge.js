/**
 * dsh-memory-setup — personal knowledge base (pure, unit-testable).
 * Lightweight local KB: keyword retrieval over structured entries
 * (no embeddings — honest v0.3 scope). Title-dedupe reuses similarity().
 */
import { similarity } from "./memory.js";

export const KB_VERSION = 1;

export function emptyKnowledge() {
  return { version: KB_VERSION, entries: [], updatedAt: null };
}

export function isValidKnowledge(kb) {
  return !!kb && kb.version === KB_VERSION && Array.isArray(kb.entries);
}

function nextId(kb, prefix) {
  return prefix + (kb.entries.length + 1);
}

/** Add an entry; merges into a similar-titled entry (dedupe >= 0.7). */
export function kbAdd(kb, input, ts) {
  const k = kb && isValidKnowledge(kb) ? structuredClone(kb) : emptyKnowledge();
  const title = String(input?.title ?? "").trim();
  const content = String(input?.content ?? "").trim();
  if (!title || !content) throw new Error("title and content are required");
  const tags = (Array.isArray(input.tags) ? input.tags : []).map((t) => String(t).trim()).filter(Boolean);
  const similar = k.entries
    .map((e) => ({ entry: e, sim: similarity(e.title, title) }))
    .filter((x) => x.sim >= 0.7)
    .sort((a, b) => b.sim - a.sim);
  if (similar.length) {
    const target = k.entries.find((e) => e.id === similar[0].entry.id);
    target.content = content;
    for (const t of tags) if (!target.tags.includes(t)) target.tags.push(t);
    target.updatedAt = ts ?? new Date().toISOString();
    k.updatedAt = ts ?? new Date().toISOString();
    return { kb: k, entry: target, deduped: true };
  }
  const entry = {
    id: nextId(k, "k"),
    title,
    content,
    tags,
    source: String(input?.source ?? "").trim() || null,
    hits: 0,
    createdAt: ts ?? new Date().toISOString(),
    updatedAt: ts ?? new Date().toISOString(),
  };
  k.entries.push(entry);
  k.updatedAt = ts ?? new Date().toISOString();
  return { kb: k, entry, deduped: false };
}

function tokenSet(s) {
  return new Set(String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

function overlap(a, b) {
  const A = tokenSet(a), B = tokenSet(b);
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n;
}

/** Keyword search: title tokens x3, tags x2, content x1. */
export function kbSearch(kb, query, { limit = 10 } = {}) {
  const k = kb && isValidKnowledge(kb) ? kb : emptyKnowledge();
  const q = String(query ?? "").trim();
  if (!q) return [];
  return k.entries
    .map((e) => ({
      entry: e,
      score: overlap(q, e.title) * 3 + overlap(q, (e.tags || []).join(" ")) * 2 + overlap(q, e.content) * 1,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.entry.updatedAt) - new Date(a.entry.updatedAt))
    .slice(0, limit)
    .map((x) => ({ ...x.entry, score: x.score }));
}

export function kbList(kb) {
  const k = kb && isValidKnowledge(kb) ? kb : emptyKnowledge();
  return [...k.entries].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export function kbRemove(kb, id) {
  const k = kb && isValidKnowledge(kb) ? structuredClone(kb) : emptyKnowledge();
  const before = k.entries.length;
  k.entries = k.entries.filter((e) => e.id !== id);
  if (k.entries.length !== before) k.updatedAt = new Date().toISOString();
  return { kb: k, removed: k.entries.length !== before };
}

export function kbHit(kb, id) {
  const k = kb && isValidKnowledge(kb) ? structuredClone(kb) : emptyKnowledge();
  const e = k.entries.find((x) => x.id === id);
  if (e) e.hits = (e.hits ?? 0) + 1;
  return k;
}

export function kbSummary(kb) {
  const k = kb && isValidKnowledge(kb) ? kb : emptyKnowledge();
  return { entries: k.entries.length, updatedAt: k.updatedAt, totalHits: k.entries.reduce((a, e) => a + (e.hits ?? 0), 0) };
}

/** Render search results / list as markdown. */
export function renderKB(entries, { detail = false } = {}) {
  if (!entries.length) return "(knowledge base is empty)";
  const out = entries.map((e, i) => {
    const head = (i + 1) + ". **" + e.title + "**" + (e.tags && e.tags.length ? "  [" + e.tags.join(", ") + "]" : "") + (e.score != null ? "  (score " + e.score + ")" : "");
    return head + (detail ? "\n   " + (e.content || "").replace(/\n/g, "\n   ") : "");
  });
  return out.join("\n");
}
