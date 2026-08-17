import test from "node:test";
import assert from "node:assert/strict";
import { extractConventions } from "../lib/scanner.js";

test("extracts npm scripts and package manager from package.json", () => {
  const files = [{ path: "package.json", text: JSON.stringify({ scripts: { dev: "vite", build: "tsc", test: "vitest" }, packageManager: "pnpm@9.0.0" }) }];
  const out = extractConventions(files);
  assert.ok(out.some((c) => c.pattern === "package-manager" && c.detail.includes("pnpm")));
  assert.ok(out.some((c) => c.detail.includes("dev, build, test")));
});

test("extracts commands from README", () => {
  const files = [{ path: "README.md", text: "Run with npm start or docker compose up. See docs." }];
  const out = extractConventions(files);
  assert.ok(out.some((c) => c.pattern === "commands" && c.evidence === "README"));
});

test("extracts env keys from .env.example", () => {
  const files = [{ path: ".env.example", text: "DATABASE_URL=\nAPI_KEY=\nPORT=3000" }];
  const out = extractConventions(files);
  const env = out.find((c) => c.pattern === "env");
  assert.ok(env && env.detail.includes("DATABASE_URL"));
});

test("detects language from tsconfig / pyproject", () => {
  const ts = extractConventions([{ path: "tsconfig.json", text: "{}" }]);
  assert.ok(ts.some((c) => c.detail.includes("typescript")));
  const py = extractConventions([{ path: "pyproject.toml", text: '[project]\nrequires-python = ">=3.11"' }]);
  assert.ok(py.some((c) => c.detail.includes("python")));
});

test("unknown files yield nothing", () => {
  assert.equal(extractConventions([{ path: "dist/bundle.js", text: "x" }]).length, 0);
});
