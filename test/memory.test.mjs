import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyMemory, isValidMemory, applySetup, updateEntry, removeEntry,
  addLesson, renderMemory, memorySummary,
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
