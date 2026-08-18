/**
 * dsh-memory-setup — pure memory model (no DSH imports, unit-testable).
 *
 * The memory doc is a small, transparent, auditable JSON file:
 *   {
 *     version: 1,
 *     preferences: { language, codeStyle, tools, notes },
 *     projectConventions: [{ id, type, detail, evidence, createdAt }],
 *     workflows: [{ id, name, steps, createdAt }],
 *     lessons: [{ id, error, fix, evidence, createdAt }],
 *     updatedAt,
 *     changelog: [{ ts, action, path, summary }]
 *   }
 * Every mutation records a changelog entry (who/what/when) so the memory
 * itself is auditable — memory plugins are the highest-trust plugin type.
 */

export const MEMORY_VERSION = 1;

export function emptyMemory() {
  return {
    version: MEMORY_VERSION,
    preferences: { language: "", codeStyle: "", tools: "", notes: "" },
    projectConventions: [],
    workflows: [],
    lessons: [],
    updatedAt: null,
    changelog: [],
  };
}

export function isValidMemory(doc) {
  return !!doc && doc.version === MEMORY_VERSION && typeof doc.preferences === "object" && Array.isArray(doc.projectConventions) && Array.isArray(doc.workflows) && Array.isArray(doc.lessons);
}

function ch(ts, action, path, summary) {
  return { ts: ts ?? new Date().toISOString(), action, path, summary };
}

/** Apply setup answers into the doc. Returns { doc, changes }. */
export function applySetup(doc, answers = {}, ts) {
  const d = doc && isValidMemory(doc) ? structuredClone(doc) : emptyMemory();
  const changes = [];
  const prefKeys = ["language", "codeStyle", "tools", "notes"];
  for (const k of prefKeys) {
    const v = String(answers[k] ?? "").trim();
    if (v && v !== (d.preferences[k] ?? "")) {
      d.preferences[k] = v;
      changes.push({ path: "preferences." + k, summary: v.slice(0, 80) });
    }
  }
  const conv = Array.isArray(answers.conventions) ? answers.conventions.map((x) => String(x).trim()).filter(Boolean) : [];
  for (const c of conv) {
    d.projectConventions.push({ id: "c" + (d.projectConventions.length + 1), type: "user", detail: c, evidence: "user-setup", createdAt: ts ?? new Date().toISOString() });
    changes.push({ path: "projectConventions", summary: c.slice(0, 80) });
  }
  const wf = Array.isArray(answers.workflows) ? answers.workflows.map((x) => String(x).trim()).filter(Boolean) : [];
  for (const w of wf) {
    d.workflows.push({ id: "w" + (d.workflows.length + 1), name: w, steps: [], createdAt: ts ?? new Date().toISOString() });
    changes.push({ path: "workflows", summary: w.slice(0, 80) });
  }
  if (changes.length) {
    d.updatedAt = ts ?? new Date().toISOString();
    d.changelog.push(ch(ts, "setup", "-", changes.length + " change(s)"));
  }
  return { doc: d, changes };
}

/** Generic update: path like "preferences.codeStyle" or "projectConventions.<id>". */
export function updateEntry(doc, path, value, note, ts) {
  const d = doc && isValidMemory(doc) ? structuredClone(doc) : emptyMemory();
  const parts = String(path).split(".").filter(Boolean);
  if (!parts.length) throw new Error("path required");
  let target = d;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof target[parts[i]] !== "object" || target[parts[i]] === null) target[parts[i]] = {};
    target = target[parts[i]];
  }
  target[parts[parts.length - 1]] = value;
  d.updatedAt = ts ?? new Date().toISOString();
  d.changelog.push(ch(ts, "update", path, note || "updated"));
  return d;
}

/** Remove an entry by path (e.g. "preferences.codeStyle"). Returns { doc, removed }. */
export function removeEntry(doc, path, ts) {
  const d = doc && isValidMemory(doc) ? structuredClone(doc) : emptyMemory();
  const parts = String(path).split(".").filter(Boolean);
  let target = d;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof target[parts[i]] !== "object" || target[parts[i]] === null) return { doc: d, removed: false };
    target = target[parts[i]];
  }
  const key = parts[parts.length - 1];
  const removed = key in target;
  if (removed) {
    delete target[key];
    d.updatedAt = ts ?? new Date().toISOString();
    d.changelog.push(ch(ts, "remove", path, "removed"));
  }
  return { doc: d, removed };
}

/** Add an error lesson (self-improvement hook, direction 1). */
export function addLesson(doc, lesson, ts) {
  const d = doc && isValidMemory(doc) ? structuredClone(doc) : emptyMemory();
  const error = String(lesson?.error ?? "").trim();
  const fix = String(lesson?.fix ?? "").trim();
  if (!error || !fix) throw new Error("error and fix are required");
  const entry = {
    id: "l" + (d.lessons.length + 1),
    error,
    fix,
    evidence: String(lesson?.evidence ?? "").trim() || null,
    createdAt: ts ?? new Date().toISOString(),
  };
  d.lessons.push(entry);
  d.updatedAt = ts ?? new Date().toISOString();
  d.changelog.push(ch(ts, "lesson", "lessons", "added: " + error.slice(0, 60)));
  return { doc: d, entry };
}

/** Render the memory as Markdown (for the model and for display). */
export function renderMemory(doc, maxChars = 6000) {
  const d = doc && isValidMemory(doc) ? doc : emptyMemory();
  const out = [];
  const has = (x) => String(x ?? "").trim().length > 0;
  if (Object.values(d.preferences).some(has)) {
    out.push("## Preferences");
    for (const [k, v] of Object.entries(d.preferences)) if (has(v)) out.push("- " + k + ": " + v);
  }
  if (d.projectConventions.length) {
    out.push("## Project conventions");
    for (const c of d.projectConventions) out.push("- " + (c.type === "user" ? "[user] " : "[auto] ") + c.detail + (c.evidence && c.evidence !== "user-setup" ? " (" + c.evidence + ")" : ""));
  }
  if (d.workflows.length) {
    out.push("## Workflows");
    for (const w of d.workflows) out.push("- " + w.name + (w.steps.length ? ": " + w.steps.join(" -> ") : ""));
  }
  if (d.lessons.length) {
    out.push("## Lessons (do not repeat these mistakes)");
    for (const l of d.lessons) out.push("- ERROR: " + l.error + " -> FIX: " + l.fix + (l.evidence ? " (evidence: " + l.evidence + ")" : ""));
  }
  let text = out.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars) + "\n... (truncated)";
  return text;
}

/** Summary counts used by tool output. */
export function memorySummary(doc) {
  const d = doc && isValidMemory(doc) ? doc : emptyMemory();
  return {
    exists: Object.values(d.preferences).some((x) => String(x).trim()) || d.projectConventions.length > 0 || d.workflows.length > 0 || d.lessons.length > 0,
    version: d.version,
    updatedAt: d.updatedAt,
    preferences: Object.values(d.preferences).filter((x) => String(x).trim()).length,
    conventions: d.projectConventions.length,
    workflows: d.workflows.length,
    lessons: d.lessons.length,
    changelog: d.changelog.length,
  };
}
// ---- v0.2: pruning, dedupe, review, export ----

/** Token overlap (Jaccard) similarity between two strings. */
export function similarity(a, b) {
  const tok = (s) => new Set(String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const A = tok(a), B = tok(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Remove expired entries and cap the changelog. Pure. */
export function pruneMemory(doc, { now = Date.now(), changelogCap = 100, lessonTtlDays = 90 } = {}) {
  const d = doc && isValidMemory(doc) ? structuredClone(doc) : emptyMemory();
  const cutoff = now - lessonTtlDays * 86400000;
  void cutoff;
  d.lessons = d.lessons.filter((l) => !l.expiresAt || new Date(l.expiresAt).getTime() > now);
  d.projectConventions = d.projectConventions.filter((c) => !c.expiresAt || new Date(c.expiresAt).getTime() > now);
  d.workflows = d.workflows.filter((w) => !w.expiresAt || new Date(w.expiresAt).getTime() > now);
  if (d.changelog.length > changelogCap) d.changelog = d.changelog.slice(d.changelog.length - changelogCap);
  return d;
}

/** Find lessons similar to a given error text. Pure. */
export function findSimilarLessons(doc, error, { threshold = 0.6 } = {}) {
  const d = doc && isValidMemory(doc) ? doc : emptyMemory();
  return d.lessons
    .map((l) => ({ lesson: l, sim: similarity(l.error, error) }))
    .filter((x) => x.sim >= threshold)
    .sort((a, b) => b.sim - a.sim);
}

/**
 * Formalize an incident review into a lesson. If a similar lesson exists,
 * bump its hits and optionally update its fix; otherwise add a new one.
 * Pure — returns { doc, entry, deduped, hits }.
 */
export function applyReview(doc, review, ts) {
  const d = doc && isValidMemory(doc) ? structuredClone(doc) : emptyMemory();
  const error = String(review?.error ?? "").trim();
  const fix = String(review?.fix ?? "").trim();
  if (!error || !fix) throw new Error("error and fix are required");
  const similar = findSimilarLessons(d, error);
  if (similar.length) {
    const target = d.lessons.find((l) => l.id === similar[0].lesson.id);
    target.hits = (target.hits ?? 1) + 1;
    if (review.evidence && !target.evidence) target.evidence = String(review.evidence).trim();
    target.lastSeenAt = ts ?? new Date().toISOString();
    d.updatedAt = ts ?? new Date().toISOString();
    d.changelog.push({ ts: ts ?? new Date().toISOString(), action: "lesson-hit", path: "lessons", summary: error.slice(0, 60) });
    return { doc: d, entry: target, deduped: true, hits: target.hits };
  }
  const entry = {
    id: "l" + (d.lessons.length + 1),
    error,
    fix,
    evidence: String(review?.evidence ?? "").trim() || null,
    rootCause: String(review?.rootCause ?? "").trim() || null,
    hits: 1,
    createdAt: ts ?? new Date().toISOString(),
  };
  if (review.expiresAt) entry.expiresAt = review.expiresAt;
  d.lessons.push(entry);
  d.updatedAt = ts ?? new Date().toISOString();
  d.changelog.push({ ts: ts ?? new Date().toISOString(), action: "lesson", path: "lessons", summary: "added: " + error.slice(0, 60) });
  return { doc: d, entry, deduped: false, hits: 1 };
}

/** Diff two memory docs into human-readable changes. Pure (v0.4). */
export function diffMemory(prev, cur) {
  const p = prev && isValidMemory(prev) ? prev : emptyMemory();
  const c = cur && isValidMemory(cur) ? cur : emptyMemory();
  const changes = [];
  for (const key of ["language", "codeStyle", "tools", "notes"]) {
    const a = p.preferences?.[key];
    const b = c.preferences?.[key];
    if (a !== b) changes.push({ path: "preferences." + key, from: a || "(none)", to: b || "(none)" });
  }
  const summaryOf = (x) => (x.error || x.detail || x.name || x.id || "entry") + (x.evidence ? " (" + x.evidence + ")" : "");
  for (const section of ["projectConventions", "workflows", "lessons"]) {
    const pa = p[section] || [];
    const ca = c[section] || [];
    const ids = new Set(ca.map((x) => x.id));
    for (const x of pa) if (!ids.has(x.id)) changes.push({ path: section, from: summaryOf(x), to: "(removed)" });
    const pids = new Set(pa.map((x) => x.id));
    for (const x of ca) if (!pids.has(x.id)) changes.push({ path: section, from: "(added)", to: summaryOf(x) });
  }
  return changes;
}

/** Render a diff list as markdown. Pure. */
export function renderDiff(changes) {
  if (!changes.length) return "(no changes)";
  return changes.map((d) => "- " + d.path + ": " + d.from + " → " + d.to).join("\n");
}

/** Full markdown export (including changelog) for review/backup. Pure. */
export function exportMarkdown(doc, { includeChangelog = true } = {}) {
  const d = doc && isValidMemory(doc) ? doc : emptyMemory();
  const out = [];
  out.push("# Personal memory export");
  out.push("");
  out.push("Generated: " + new Date().toISOString());
  out.push("");
  out.push(renderMemory(d));
  if (includeChangelog && d.changelog.length) {
    out.push("");
    out.push("## Changelog");
    for (const c of d.changelog) out.push("- " + (c.ts || "?") + " [" + c.action + "] " + c.path + ": " + c.summary);
  }
  return out.join("\n");
}
/** Bulk-apply an array of incident reviews with per-item dedupe. Pure (v0.5). */
export function applyReviews(doc, incidents, ts) {
  let d = doc && isValidMemory(doc) ? structuredClone(doc) : emptyMemory();
  let added = 0, merged = 0;
  for (const inc of incidents || []) {
    if (!inc || !String(inc.error ?? "").trim() || !String(inc.fix ?? "").trim()) continue;
    const r = applyReview(d, inc, ts);
    d = r.doc;
    if (r.deduped) merged++; else added++;
  }
  return { doc: d, added, merged };
}
// ---- v0.7: lesson promotion + stats ----

/**
 * Promote recurring lessons (hits >= threshold) into standing project
 * conventions — the memory literally 'learns' from repeated mistakes.
 * Pure. Returns { doc, promoted }.
 */
export function promoteLessons(doc, { hitThreshold = 3, ts } = {}) {
  const d = doc && isValidMemory(doc) ? structuredClone(doc) : emptyMemory();
  const promoted = [];
  for (const l of d.lessons) {
    const hits = l.hits ?? 1;
    if (hits < hitThreshold || l.expiresAt) continue;
    const detail = "[learned] " + l.fix + " (from: " + l.error.slice(0, 60) + ")";
    if (d.projectConventions.some((c) => c.detail === detail)) continue;
    d.projectConventions.push({
      id: "c" + (d.projectConventions.length + 1),
      type: "learned",
      pattern: "lesson",
      detail,
      evidence: l.evidence || "lesson #" + l.id + " x" + hits,
      createdAt: ts ?? new Date().toISOString(),
    });
    promoted.push({ lesson: l, detail });
  }
  if (promoted.length) {
    d.updatedAt = ts ?? new Date().toISOString();
    d.changelog.push({ ts: ts ?? new Date().toISOString(), action: "promote", path: "projectConventions", summary: promoted.length + " lesson(s) promoted" });
  }
  return { doc: d, promoted };
}

/** Aggregate stats across memory, knowledge base and snapshots. Pure. */
export function computeStats(doc, kb, snapshots) {
  const d = doc && isValidMemory(doc) ? doc : emptyMemory();
  const k = kb && typeof kb === "object" && Array.isArray(kb.entries) ? kb : { entries: [] };
  const lessons = d.lessons || [];
  const topLessons = [...lessons].sort((a, b) => (b.hits ?? 1) - (a.hits ?? 1)).slice(0, 3);
  return {
    updatedAt: d.updatedAt,
    preferences: Object.values(d.preferences || {}).filter((x) => String(x).trim()).length,
    conventions: (d.projectConventions || []).length,
    workflows: (d.workflows || []).length,
    lessons: lessons.length,
    lessonHits: lessons.reduce((a, l) => a + (l.hits ?? 1), 0),
    topLessons: topLessons.map((l) => ({ id: l.id, error: l.error.slice(0, 50), hits: l.hits ?? 1 })),
    knowledgeEntries: k.entries.length,
    knowledgeHits: k.entries.reduce((a, e) => a + (e.hits ?? 0), 0),
    snapshots: Array.isArray(snapshots) ? snapshots.length : 0,
    changelog: (d.changelog || []).length,
  };
}

/** Render stats as markdown. Pure. */
export function renderStats(s) {
  const out = [];
  out.push("Memory stats");
  out.push("- preferences: " + s.preferences);
  out.push("- conventions: " + s.conventions);
  out.push("- workflows: " + s.workflows);
  out.push("- lessons: " + s.lessons + " (" + s.lessonHits + " total hits)");
  if (s.topLessons.length) {
    out.push("  top lessons:");
    for (const l of s.topLessons) out.push("    - " + l.error + " (x" + l.hits + ")");
  }
  out.push("- knowledge: " + s.knowledgeEntries + " entries (" + s.knowledgeHits + " hits)");
  out.push("- snapshots: " + s.snapshots);
  out.push("- changelog entries: " + s.changelog);
  out.push("- last updated: " + (s.updatedAt || "never"));
  return out.join("\n");
}

// ---- v0.6: troubleshoot assist + snapshots ----

/**
 * Find the best-known fix for an error from past lessons. Pure.
 * @returns {lesson, fix, sim} | null
 */
export function findLessonFix(doc, error, { threshold = 0.4 } = {}) {
  const d = doc && isValidMemory(doc) ? doc : emptyMemory();
  const similar = findSimilarLessons(d, error, { threshold });
  if (!similar.length) return null;
  const top = similar[0].lesson;
  return { lesson: top, fix: top.fix, sim: similar[0].sim, evidence: top.evidence };
}

/** Stable snapshot id from a timestamp. Pure. */
export function snapshotId(ts) {
  return "mem-" + new Date(ts ?? Date.now()).toISOString().replace(/[:.]/g, "-");
}

/** Keep the latest N snapshots (by ts), oldest first. Pure. */
export function pruneSnapshots(snapshots, keep = 10) {
  const list = [...(snapshots || [])].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return list.length > keep ? list.slice(list.length - keep) : list;
}



