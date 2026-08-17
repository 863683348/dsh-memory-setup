import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyKnowledge, isValidKnowledge, kbAdd, kbSearch, kbList, kbRemove, kbHit, kbSummary, renderKB, kbSearchBM25,
} from "../lib/knowledge.js";

test("emptyKnowledge is valid", () => {
  assert.ok(isValidKnowledge(emptyKnowledge()));
  assert.equal(kbSummary(emptyKnowledge()).entries, 0);
});

test("kbAdd stores an entry with tags and source", () => {
  const { kb, entry, deduped } = kbAdd(emptyKnowledge(), { title: "pnpm tips", content: "use pnpm approve-builds", tags: ["pnpm", "build"], source: "README" });
  assert.equal(deduped, false);
  assert.equal(kb.entries.length, 1);
  assert.equal(entry.tags.length, 2);
  assert.equal(kbSummary(kb).entries, 1);
  assert.ok(renderKB(kb.entries).includes("pnpm tips"));
});

test("kbAdd merges similar titles", () => {
  const first = kbAdd(emptyKnowledge(), { title: "pnpm install troubleshooting", content: "delete lockfile" });
  const second = kbAdd(first.kb, { title: "pnpm install troubleshooting guide", content: "delete lockfile and reinstall", tags: ["pnpm"] });
  assert.equal(second.deduped, true);
  assert.equal(second.kb.entries.length, 1);
  assert.equal(second.entry.content, "delete lockfile and reinstall");
});

test("kbSearch ranks by title over content", () => {
  const k1 = kbAdd(emptyKnowledge(), { title: "deploy script", content: "uses docker" }).kb;
  const k2 = kbAdd(k1, { title: "unrelated", content: "the deploy script pushes images" }).kb;
  const results = kbSearch(k2, "deploy");
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "deploy script");
  assert.ok(results[0].score > results[1].score);
});

test("kbRemove and kbHit work", () => {
  const { kb, entry } = kbAdd(emptyKnowledge(), { title: "x", content: "y" });
  const hit = kbHit(kb, entry.id);
  assert.equal(kbSummary(hit).totalHits, 1);
  const { kb: after, removed } = kbRemove(hit, entry.id);
  assert.equal(removed, true);
  assert.equal(after.entries.length, 0);
});

test("kbAdd requires title and content", () => {
  assert.throws(() => kbAdd(emptyKnowledge(), { title: "", content: "x" }), /title and content/);
});

test("kbSearchBM25 ranks title matches above content-only matches (v0.4)", () => {
  let k = kbAdd(emptyKnowledge(), { title: "docker deploy guide", content: "build image and push" }).kb;
  k = kbAdd(k, { title: "random notes", content: "the docker deploy guide explains image push steps" }).kb;
  const r = kbSearchBM25(k, "docker deploy guide");
  assert.equal(r.length, 2);
  assert.equal(r[0].title, "docker deploy guide");
  assert.ok(r[0].score > r[1].score);
});

test("kbSearchBM25 empty query returns nothing", () => {
  const k = kbAdd(emptyKnowledge(), { title: "x", content: "y" }).kb;
  assert.equal(kbSearchBM25(k, "").length, 0);
});
