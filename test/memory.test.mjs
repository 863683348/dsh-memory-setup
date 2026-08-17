import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyMemory, isValidMemory, applySetup, updateEntry, removeEntry,
  addLesson, renderMemory, memorySummary, similarity, pruneMemory,
  applyReview, exportMarkdown, diffMemory, renderDiff,
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
