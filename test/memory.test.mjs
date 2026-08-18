import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyMemory, isValidMemory, applySetup, updateEntry, removeEntry,
  addLesson, renderMemory, memorySummary, similarity, pruneMemory,
  applyReview, applyReviews, exportMarkdown, diffMemory, renderDiff,
  findLessonFix, snapshotId, pruneSnapshots, promoteLessons, computeStats, renderStats,
  migrateMemory, mergeMemories, memoryFromJSON, updateLessonHealth, selectRelevant,
  setTier, redactDoc, auditReport, parseClaudeMd, annotateEntry, buildBundle, parseBundle,
} from "../lib/memory.js";

test("emptyMemory is valid and renders empty", () => {
  const d = emptyMemory();
  assert.ok(isValidMemory(d));
  assert.equal(renderMemory(d), "");
  assert.equal(memorySummary(d).exists, false);
});

test("applySetup stores preferences, conventions and workflows with changelog", () => {
  const { doc } = applySetup(emptyMemory(), {
    language: "TypeScript", codeStyle: "2-space indent", tools: "node, pnpm",
    conventions: ["use pnpm", "tests in test/"], workflows: ["release", "code-review"],
  });
  assert.equal(doc.preferences.language, "TypeScript");
  assert.equal(doc.projectConventions.length, 2);
  assert.equal(doc.workflows.length, 2);
  assert.equal(doc.changelog.length, 1);
  assert.ok(doc.updatedAt);
  assert.ok(renderMemory(doc).includes("## Preferences"));
  assert.ok(renderMemory(doc).includes("use pnpm"));
  assert.ok(memorySummary(doc).exists);
});

test("applySetup is idempotent for unchanged values", () => {
  const base = applySetup(emptyMemory(), { language: "Go" }).doc;
  const again = applySetup(base, { language: "Go" });
  assert.equal(again.changes.length, 0);
  assert.equal(again.doc.changelog.length, base.changelog.length);
});

test("updateEntry writes a nested path and logs changelog", () => {
  const d = updateEntry(emptyMemory(), "preferences.codeStyle", "tabs", "switch to tabs");
  assert.equal(d.preferences.codeStyle, "tabs");
  assert.equal(d.changelog.at(-1).action, "update");
});

test("removeEntry deletes a key", () => {
  const withVal = updateEntry(emptyMemory(), "preferences.language", "Rust");
  const { doc, removed } = removeEntry(withVal, "preferences.language");
  assert.equal(removed, true);
  assert.equal(doc.preferences.language, undefined);
});

test("addLesson requires error and fix, records evidence", () => {
  const { doc, entry } = addLesson(emptyMemory(), { error: "forgot pnpm install", fix: "always run pnpm install first", evidence: "run 3, exit 127" });
  assert.equal(doc.lessons.length, 1);
  assert.equal(entry.evidence, "run 3, exit 127");
  assert.ok(renderMemory(doc).includes("do not repeat"));
  assert.throws(() => addLesson(emptyMemory(), { error: "" }), /error and fix/);
});

test("renderMemory truncates over maxChars", () => {
  const { doc } = applySetup(emptyMemory(), { language: "X".repeat(3000) });
  const md = renderMemory(doc, 2000);
  assert.ok(md.length <= 2000 + 20);
  assert.ok(md.includes("truncated"));
});

// ---- v0.2 ----
test("similarity: overlapping text scores high, unrelated scores low", () => {
  assert.ok(similarity("pnpm install failed with ENOENT", "pnpm install failed with ENOENT") > 0.9);
  assert.ok(similarity("pnpm install failed with ENOENT", "docker build failed") < 0.3);
});

test("pruneMemory removes expired lessons and caps changelog", () => {
  let { doc } = applySetup(emptyMemory(), { conventions: ["old"] });
  doc.lessons.push({ id: "l1", error: "old lesson", fix: "x", expiresAt: "2020-01-01T00:00:00Z" });
  doc.lessons.push({ id: "l2", error: "fresh lesson", fix: "y", createdAt: new Date().toISOString() });
  for (let i = 0; i < 120; i++) doc.changelog.push({ ts: new Date().toISOString(), action: "t", path: "-", summary: "s" });
  const pruned = pruneMemory(doc, { now: Date.now(), changelogCap: 100 });
  assert.equal(pruned.lessons.length, 1);
  assert.equal(pruned.lessons[0].id, "l2");
  assert.equal(pruned.changelog.length, 100);
});

test("applyReview dedupes similar lessons and bumps hits", () => {
  const first = applyReview(emptyMemory(), { error: "npm install fails due to lockfile mismatch", fix: "delete lockfile and reinstall" });
  assert.equal(first.deduped, false);
  assert.equal(first.hits, 1);
  const again = applyReview(first.doc, { error: "npm install failed due to lockfile mismatch again", fix: "same fix", evidence: "run 5" });
  assert.equal(again.deduped, true);
  assert.equal(again.hits, 2);
  assert.equal(again.doc.lessons.length, 1);
  assert.equal(again.entry.evidence, "run 5");
});

test("exportMarkdown includes changelog and renders", () => {
  const { doc } = applySetup(emptyMemory(), { language: "Go" });
  const md = exportMarkdown(doc);
  assert.ok(md.includes("# Personal memory export"));
  assert.ok(md.includes("## Changelog"));
  assert.ok(md.includes("Go"));
});

test("diffMemory reports preference changes and added lessons (v0.4)", () => {
  const prev = applySetup(emptyMemory(), { language: "Go" }).doc;
  const cur = updateEntry(prev, "preferences.language", "Rust", "switch");
  const withLesson = addLesson(cur, { error: "ENOENT on build", fix: "run install first" }).doc;
  const changes = diffMemory(prev, withLesson);
  assert.ok(changes.some((d) => d.path === "preferences.language" && d.from === "Go" && d.to === "Rust"));
  assert.ok(changes.some((d) => d.path === "lessons" && d.from === "(added)"));
  assert.ok(renderDiff(changes).includes("preferences.language: Go → Rust"));
});

test("diffMemory empty when identical", () => {
  const d = applySetup(emptyMemory(), { language: "Go" }).doc;
  assert.equal(diffMemory(d, d).length, 0);
});

test("findLessonFix returns best-known fix (v0.6)", () => {
  const { doc } = applyReviews(emptyMemory(), [
    { error: "build fails due to missing env", fix: "load .env first", evidence: "run 2" },
  ]);
  const hit = findLessonFix(doc, "build failed due to missing environment variable");
  assert.ok(hit);
  assert.equal(hit.fix, "load .env first");
  assert.equal(findLessonFix(doc, "completely unrelated topic here"), null);
});

test("snapshotId and pruneSnapshots (v0.6)", () => {
  const id = snapshotId(new Date("2026-08-17T12:00:00Z"));
  assert.ok(/^mem-2026-08-17T12-00-00/.test(id));
  const snaps = [
    { id: "a", ts: "2026-08-17T10:00:00Z" },
    { id: "b", ts: "2026-08-17T11:00:00Z" },
    { id: "c", ts: "2026-08-17T12:00:00Z" },
  ];
  const pruned = pruneSnapshots(snaps, 2);
  assert.equal(pruned.length, 2);
  assert.equal(pruned[0].id, "b");
  assert.equal(pruned[1].id, "c");
});

test("promoteLessons turns recurring lessons into conventions (v0.7)", () => {
  const { doc: withLesson } = applyReviews(emptyMemory(), [{ error: "port already in use", fix: "use port 3001" }]);
  // bump hits to 3 by re-applying similar reviews
  let d = withLesson;
  d = applyReview(d, { error: "port already in use again", fix: "use port 3001" }).doc;
  d = applyReview(d, { error: "port 3000 already in use", fix: "use port 3001" }).doc;
  const { doc: promotedDoc, promoted } = promoteLessons(d, { hitThreshold: 3 });
  assert.equal(promoted.length, 1);
  assert.ok(promotedDoc.projectConventions.some((c) => c.type === "learned" && c.detail.includes("use port 3001")));
  // dedupe: promoting again adds nothing
  const again = promoteLessons(promotedDoc, { hitThreshold: 3 });
  assert.equal(again.promoted.length, 0);
});

test("promoteLessons respects hit threshold (v0.7)", () => {
  const { doc } = applyReview(emptyMemory(), { error: "rare failure", fix: "rare fix" });
  const { promoted } = promoteLessons(doc, { hitThreshold: 3 });
  assert.equal(promoted.length, 0);
});

test("migrateMemory normalizes v1 docs to schema v2 (v0.8)", () => {
  const old = { version: 1, preferences: { language: "Go" }, projectConventions: [{ id: "c1", detail: "x" }], workflows: "not-an-array", lessons: null, updatedAt: null };
  const m = migrateMemory(old);
  assert.equal(m.schemaVersion, 2);
  assert.ok(Array.isArray(m.workflows));
  assert.ok(Array.isArray(m.lessons));
  assert.equal(m.preferences.language, "Go");
});

test("mergeMemories unions entries and picks newer preferences (v0.8)", () => {
  const a = applySetup(emptyMemory(), { language: "Go", conventions: ["use pnpm"] }).doc;
  const b = applySetup(emptyMemory(), { language: "Rust", conventions: ["use cargo"] }).doc;
  b.updatedAt = new Date(Date.now() + 10000).toISOString();
  const m = mergeMemories(a, b, { conflict: "newer" });
  assert.equal(m.preferences.language, "Rust");
  assert.equal(m.projectConventions.length, 2);
  const both = mergeMemories(a, b, { conflict: "both" });
  assert.equal(both.projectConventions.length, 2);
});

test("memoryFromJSON validates and migrates (v0.8)", () => {
  const m = memoryFromJSON(JSON.stringify({ version: 1, preferences: { language: "JS" } }));
  assert.equal(m.preferences.language, "JS");
  assert.throws(() => memoryFromJSON("not json"), /invalid JSON/);
  assert.throws(() => memoryFromJSON(JSON.stringify({ foo: 1 })), /valid memory/);
});

test("updateLessonHealth marks failing and resolved (v0.9)", () => {
  const { doc } = applyReviews(emptyMemory(), [{ error: "build fails on windows", fix: "fix it" }]);
  let d = applyReview(doc, { error: "build fails on windows", fix: "fix it" }).doc;
  d = applyReview(d, { error: "build fails on windows", fix: "fix it" }).doc; // hits=3, lastSeen now
  const now = Date.now();
  const h = updateLessonHealth(d, { now });
  assert.equal(h.lessons[0].health, "failing");
  const old = applyReviews(emptyMemory(), [{ error: "old bug", fix: "fixed long ago" }]).doc;
  old.lessons[0].hits = 3;
  old.lessons[0].lastSeenAt = new Date(now - 60 * 86400000).toISOString();
  const r = updateLessonHealth(old, { now });
  assert.equal(r.lessons[0].health, "resolved");
});

test("selectRelevant picks matching conventions/lessons (v0.9)", () => {
  const { doc } = applySetup(emptyMemory(), { conventions: ["use pnpm for installs", "tests in test/"] });
  const rel = selectRelevant(doc, "pnpm install");
  assert.ok(rel.conventions.some((c) => c.detail.includes("pnpm")));
});

test("setTier updates entry tier (v1.0)", () => {
  const { doc } = applyReviews(emptyMemory(), [{ error: "x fails", fix: "y" }]);
  const next = setTier(doc, "lesson", doc.lessons[0].id, "cold");
  assert.equal(next.lessons[0].tier, "cold");
  assert.throws(() => setTier(doc, "lesson", "nope", "hot"), /not found/);
});

test("redactDoc hides sensitive preference keys (v1.0)", () => {
  const { doc } = applySetup(emptyMemory(), { language: "Go", notes: "apiKey=SECRET" });
  const r = redactDoc(doc, ["notes"]);
  assert.equal(r.preferences.notes, "[redacted]");
  assert.equal(r.preferences.language, "Go");
});

test("auditReport reports integrity match/mismatch (v1.0)", () => {
  const { doc } = applySetup(emptyMemory(), { language: "Go" });
  const ok = auditReport(doc, "abc123", "abc123");
  assert.ok(ok.includes("OK"));
  const bad = auditReport(doc, "abc", "def");
  assert.ok(bad.includes("MISMATCH"));
});

test("parseClaudeMd extracts conventions (v1.1)", () => {
  const convs = parseClaudeMd("# Project\n## Rules\n- always run pnpm install first\n- never commit secrets\n# Other\nshort");
  assert.equal(convs.length, 2);
  assert.ok(convs[0].detail.includes("pnpm install"));
});

test("annotateEntry adds owner/purpose (v1.2)", () => {
  const { doc } = applyReviews(emptyMemory(), [{ error: "x", fix: "y" }]);
  const next = annotateEntry(doc, "lesson", doc.lessons[0].id, { owner: "alice", purpose: "ci" });
  assert.equal(next.lessons[0].owner, "alice");
  assert.equal(next.lessons[0].purpose, "ci");
});

test("buildBundle and parseBundle round-trip (v1.2)", () => {
  const { doc } = applySetup(emptyMemory(), { language: "Go" });
  const kb = { version: 1, entries: [{ id: "k1", title: "t", content: "c", tags: [], hits: 0 }] };
  const bundle = buildBundle(doc, kb, [{ id: "s1" }]);
  const parsed = parseBundle(JSON.stringify(bundle));
  assert.equal(parsed.memory.preferences.language, "Go");
  assert.equal(parsed.knowledge.entries.length, 1);
  assert.throws(() => parseBundle(JSON.stringify({ foo: 1 })), /not a valid bundle/);
});

test("computeStats aggregates memory, knowledge and snapshots (v0.7)", () => {
  const { doc } = applySetup(emptyMemory(), { language: "Go", conventions: ["a"] });
  const kb = { version: 1, entries: [{ id: "k1", title: "x", content: "y", tags: [], hits: 2 }] };
  const stats = computeStats(doc, kb, [{ id: "s1" }]);
  assert.equal(stats.preferences, 1);
  assert.equal(stats.conventions, 1);
  assert.equal(stats.knowledgeEntries, 1);
  assert.equal(stats.knowledgeHits, 2);
  assert.equal(stats.snapshots, 1);
  assert.ok(renderStats(stats).includes("Memory stats"));
});

test("applyReviews batches incidents with dedupe (v0.5)", () => {
  const base = applyReviews(emptyMemory(), [
    { error: "build fails due to missing env", fix: "load .env first", evidence: "run 2" },
    { error: "npm cache corrupted", fix: "clear cache", evidence: "run 4" },
  ]);
  assert.equal(base.added, 2);
  assert.equal(base.merged, 0);
  const again = applyReviews(base.doc, [
    { error: "build fails due to missing env again", fix: "load .env first" },
    { error: "another issue", fix: "fix it" },
  ]);
  assert.equal(again.merged, 1);
  assert.equal(again.added, 1);
  assert.equal(again.doc.lessons.length, 3);
});
