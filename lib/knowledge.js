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

// ---- v0.4: BM25 retrieval (pure, no deps) ----

function tokenize(s) {
  return String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * BM25-ranked retrieval. Fields are weighted: title tokens x3, tags x2,
 * content x1 (both for term frequency and field length).
 */
export function kbSearchBM25(kb, query, { limit = 10, k1 = 1.5, b = 0.75 } = {}) {
  const k = kb && isValidKnowledge(kb) ? kb : emptyKnowledge();
  const q = tokenize(query);
  if (!k.entries.length || !q.length) return [];
  const docs = k.entries.map((e) => ({
    entry: e,
    title: tokenize(e.title),
    tags: tokenize((e.tags || []).join(" ")),
    content: tokenize(e.content),
  }));
  const N = docs.length;
  const len = (d) => d.title.length * 3 + d.tags.length * 2 + d.content.length;
  const avgdl = docs.reduce((a, d) => a + len(d), 0) / N || 1;
  const df = new Map();
  for (const d of docs) {
    const seen = new Set();
    for (const t of [...d.title, ...d.tags, ...d.content]) {
      if (!seen.has(t)) { seen.add(t); df.set(t, (df.get(t) ?? 0) + 1); }
    }
  }
  const idf = (t) => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
  const freq = (toks, t) => { let n = 0; for (const x of toks) if (x === t) n++; return n; };
  const scored = docs.map((d) => {
    const dl = len(d);
    let score = 0;
    for (const t of q) {
      const f = freq(d.title, t) * 3 + freq(d.tags, t) * 2 + freq(d.content, t);
      if (f > 0) score += idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / avgdl)));
    }
    return { entry: d.entry, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ ...x.entry, score: Math.round(x.score * 1000) / 1000 }));
}
// ---- v0.5: embeddings (optional provider; pure cosine scoring) ----

/** Cosine similarity between two vectors. Pure. */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Cosine-ranked retrieval over entries that carry a stored `embedding`.
 * Entries without an embedding get score 0. Pure.
 */
export function embeddingSearch(kb, queryVec, { limit = 10 } = {}) {
  const k = kb && isValidKnowledge(kb) ? kb : emptyKnowledge();
  if (!Array.isArray(queryVec) || !queryVec.length) return [];
  return k.entries
    .map((e) => ({ entry: e, score: cosineSimilarity(e.embedding, queryVec) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ ...x.entry, score: Math.round(x.score * 10000) / 10000 }));
}

