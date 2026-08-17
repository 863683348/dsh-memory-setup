/**
 * scripts/publish-v5.mjs — npm publish via raw registry HTTP (no npm CLI).
 * npm-shaped tarball: entries prefixed with "package/", contents from
 * package.json "files" + auto README/LICENSE. Token from secrets.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import crypto from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "https://registry.npmjs.org";
const TO = 20000;

function loadToken() {
  if (process.env.NPM_TOKEN) return process.env.NPM_TOKEN.trim();
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE, ".dsh");
  const p = join(home, "secrets", "npm-token.txt");
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  throw new Error("npm token missing");
}

function collectFiles() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const wanted = new Set(pkg.files || []);
  wanted.add("package.json");
  for (const name of ["README.md", "README.zh.md", "LICENSE", "LICENSE.md", "cordis.patch.yml"]) {
    if (existsSync(join(ROOT, name))) wanted.add(name);
  }
  const out = [];
  const walk = (rel) => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const f of readdirSync(abs)) walk(join(rel, f));
    } else {
      out.push({ name: "package/" + rel.split("\\").join("/"), data: readFileSync(abs) });
    }
  };
  for (const w of wanted) walk(w);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function tar(files) {
  const blocks = [];
  const pad = (buf, size) => { const o = Buffer.alloc(size); buf.copy(o); return o; };
  for (const { name, data } of files) {
    const content = Buffer.from(data);
    const header = Buffer.alloc(512);
    const write = (off, len, str) => header.write(str, off, len, "utf8");
    write(0, 100, name);
    write(100, 8, "644");
    write(108, 8, "0");
    write(116, 8, "0");
    write(124, 12, content.length.toString(8));
    write(136, 12, Math.floor(Date.now() / 1000).toString(8));
    write(148, 8, "0");
    header[156] = 0x30;
    write(257, 6, "ustar");
    write(263, 2, "00");
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    blocks.push(header);
    if (content.length) blocks.push(pad(content, Math.ceil(content.length / 512) * 512));
  }
  blocks.push(Buffer.alloc(512), Buffer.alloc(512));
  return Buffer.concat(blocks);
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const name = pkg.name, version = pkg.version;
const readme = existsSync(join(ROOT, "README.md")) ? readFileSync(join(ROOT, "README.md"), "utf8") : "";
const files = collectFiles();
const tarball = zlib.gzipSync(tar(files), { level: 9 });
const shasum = crypto.createHash("sha1").update(tarball).digest("hex");
const integrity = "sha512-" + crypto.createHash("sha512").update(tarball).digest("base64");
const tarballName = name + "-" + version + ".tgz";

const versionDoc = {
  _id: name + "@" + version, name, version, description: pkg.description,
  main: pkg.main, type: pkg.type, license: pkg.license, files: pkg.files,
  scripts: pkg.scripts, publishConfig: pkg.publishConfig, dsh: pkg.dsh,
  exports: pkg.exports, keywords: pkg.keywords, peerDependencies: pkg.peerDependencies,
  dist: { integrity, shasum, tarball: REGISTRY + "/" + name + "/-" + tarballName },
};
const doc = {
  _id: name, name, description: pkg.description,
  "dist-tags": { latest: version },
  versions: { [version]: versionDoc }, readme,
  _attachments: { [tarballName]: { content_type: "application/octet-stream", data: tarball.toString("base64"), length: tarball.length } },
};

const token = loadToken();
console.log("pkg=" + name + "@" + version + " files=" + files.length + " bytes=" + tarball.length);
console.log("paths=" + files.map((f) => f.name).join(","));

const who = await fetch(REGISTRY + "/-/whoami", { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(TO) });
console.log("whoami status=" + who.status);
if (!who.ok) { console.log(await who.text()); process.exit(1); }

for (let attempt = 1; attempt <= 3; attempt++) {
  const put = await fetch(REGISTRY + "/" + encodeURIComponent(name), {
    method: "PUT",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "User-Agent": "dsh-plugin-audit/publish" },
    body: JSON.stringify(doc),
    signal: AbortSignal.timeout(60000),
  });
  const body = await put.text();
  console.log("PUT attempt " + attempt + " status=" + put.status + " body=" + body.slice(0, 400));
  if (put.ok) { console.log("OK: https://www.npmjs.com/package/" + name); process.exit(0); }
  if (put.status !== 429) process.exit(1);
  await new Promise((r) => setTimeout(r, 25000));
}
process.exit(1);
