import { name, inject, Config, apply } from "../lib/index.js";
const tools = [];
const contexts = [];
const ctx = {
  tools: { register: (t) => tools.push(t) },
  systemPrompt: { context: (c) => { contexts.push(c); return () => {}; } },
  effect: (fn) => fn(),
  fs: {},
  workspace: { path: undefined },
};
const config = Config();
apply(ctx, config);
console.log("name=" + name);
console.log("inject=" + JSON.stringify(inject));
console.log("tools=" + tools.map((t) => t.name).join(","));
console.log("contexts=" + contexts.map((c) => c.name).join(","));
const want = ["memory_setup", "memory_status", "memory_update", "memory_project", "memory_lesson", "memory_review", "memory_export", "memory_diff", "knowledge_add", "knowledge_search", "knowledge_list", "knowledge_remove"];
for (const w of want) if (!tools.some((t) => t.name === w)) throw new Error("missing " + w);
if (!contexts.some((c) => c.name === "memory:content")) throw new Error("missing memory context");
console.log("SMOKE OK");
