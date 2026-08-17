/**
 * dsh-memory-setup — project convention extraction (pure, unit-testable).
 * Takes a bounded set of workspace files and returns proposed conventions
 * with evidence. Scanner never writes; the tool decides what to apply.
 */

const COMMAND_RE = /(npm|yarn|pnpm|bun|pip|pip3|poetry|uv|python|python3|make|docker|docker-compose|gradle|mvn|cargo|go run|ruby)\s+[^\n]{0,60}/gi;

function extractFromPackageJson(text, out) {
  try {
    const pkg = JSON.parse(text);
    const scripts = pkg.scripts ? Object.keys(pkg.scripts) : [];
    if (scripts.length) {
      out.push({ type: "workflow", pattern: "package-manager", detail: "npm scripts: " + scripts.slice(0, 8).join(", "), evidence: "package.json" });
    }
    const pkgManager = pkg.packageManager || (pkg.lockfileVersion ? "npm" : null);
    if (pkgManager) out.push({ type: "config", pattern: "package-manager", detail: "declared package manager: " + pkgManager, evidence: "package.json" });
  } catch { /* not json */ }
}

function extractFromReadme(text, out) {
  const commands = new Set();
  for (const m of text.matchAll(COMMAND_RE)) commands.add(m[1].toLowerCase());
  if (commands.size) {
    out.push({ type: "workflow", pattern: "commands", detail: "documented commands: " + [...commands].slice(0, 6).join(", "), evidence: "README" });
  }
}

function extractFromEnvExample(text, out) {
  const vars = [...text.matchAll(/^([A-Z][A-Z0-9_]{2,})/gm)].map((m) => m[1]).slice(0, 10);
  if (vars.length) out.push({ type: "config", pattern: "env", detail: "environment keys: " + vars.join(", "), evidence: ".env.example" });
}

function extractFromConfig(text, out, path) {
  if (/python|pyproject|requirements/.test(path)) {
    const langs = [];
    if (/\[project\]|pypi|requires-python/.test(text)) langs.push("python (pyproject)");
    if (/requirements/.test(path)) langs.push("python (requirements)");
    if (langs.length) out.push({ type: "config", pattern: "language", detail: langs.join(", "), evidence: path });
  }
  if (/tsconfig/.test(path)) out.push({ type: "config", pattern: "language", detail: "typescript (tsconfig)", evidence: path });
}

/**
 * @param files [{path, text}] — bounded set of workspace files
 * @returns [{type, pattern, detail, evidence}] proposed conventions
 */
export function extractConventions(files) {
  const out = [];
  for (const f of files || []) {
    const path = String(f.path || "");
    const text = String(f.text || "");
    if (path === "package.json" || path.endsWith("/package.json")) extractFromPackageJson(text, out);
    else if (/^readme(\.md|\.txt|\.rst)?$/i.test(path.split("/").pop() || "")) extractFromReadme(text, out);
    else if (path === ".env.example" || path.endsWith("/.env.example")) extractFromEnvExample(text, out);
    else extractFromConfig(text, out, path);
  }
  return out;
}
