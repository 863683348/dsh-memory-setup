import { name, inject, Config, apply } from "../lib/index.js";
const tools = [];
const sections = [];
const ctx = {
  tools: { register: (t) => tools.push(t) },
  systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
  effect: (fn) => fn(),
  fs: {},
};
const config = Config();
apply(ctx, config);
console.log("name=" + name);
console.log("inject=" + JSON.stringify(inject));
console.log("tools=" + tools.map((t) => t.name).join(","));
console.log("sections=" + sections.map((s) => s.name).join(","));
const want = ["memory_setup", "memory_status", "memory_update", "memory_project", "memory_lesson"];
for (const w of want) if (!tools.some((t) => t.name === w)) throw new Error("missing " + w);
if (!sections.some((s) => s.name === "memory:setup")) throw new Error("missing memory section");
console.log("SMOKE OK");
