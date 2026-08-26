#!/usr/bin/env node
// Vendor the OFFLINE @vibe-cafe/vibe-usage CLI fork into
// src-tauri/resources/cli and apply the Windows patches.
//
// Usage:
//   node scripts/vendor-cli.mjs                       # from the sibling checkout ../vibe-usage
//   node scripts/vendor-cli.mjs --from-local <path>   # explicit checkout path
//   node scripts/vendor-cli.mjs --from-tarball <tgz>  # a packed tarball of the fork
//
// The offline fork must never be resolved from the npm registry — the
// registry carries the online-era CLI that uploads to vibecafe.ai.
// The CLI has zero npm dependencies, so vendoring bin/ + src/ + package.json
// is sufficient — no node_modules.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LOCAL = "../vibe-usage";
const destDir = path.join(root, "src-tauri", "resources", "cli");

function log(msg) {
  console.log(`[vendor-cli] ${msg}`);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function copyPackage(pkgDir) {
  for (const p of ["bin", "src", "package.json"]) {
    if (!fs.existsSync(path.join(pkgDir, p))) {
      throw new Error(`CLI package missing ${p}/ — wrong path?`);
    }
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  copyDir(path.join(pkgDir, "bin"), path.join(destDir, "bin"));
  copyDir(path.join(pkgDir, "src"), path.join(destDir, "src"));
  fs.copyFileSync(path.join(pkgDir, "package.json"), path.join(destDir, "package.json"));
}

function vendorFromLocal(localPath) {
  const abs = path.resolve(root, localPath);
  log(`vendoring from local checkout: ${abs}`);
  copyPackage(abs);
}

function vendorFromTarball(tarballPath) {
  const abs = path.resolve(root, tarballPath);
  if (!fs.existsSync(abs)) throw new Error(`tarball not found: ${abs}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-cli-"));
  try {
    execFileSync("tar", ["-xzf", abs, "-C", tmp], { stdio: "inherit" });
    log(`vendoring from tarball: ${abs}`);
    copyPackage(path.join(tmp, "package"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function optionValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

// ---------------------------------------------------------------------------
// Windows patches. Each patch aborts loudly when its anchor is missing so a
// CLI upgrade can't silently ship unpatched.

function patchFile(rel, replacements) {
  const file = path.join(destDir, rel);
  let content = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  for (const [from, to, name] of replacements) {
    if (!content.includes(from)) {
      throw new Error(`patch anchor missing in ${rel} (${name}) — CLI changed; re-verify patches`);
    }
    content = content.split(from).join(to);
  }
  fs.writeFileSync(file, content);
  log(`patched ${rel}`);
}

function applyWindowsPatches() {
  // 1. Windows cwd uses backslashes — project extraction must split on both.
  patchFile("src/parsers/codex.js", [
    [
      "if (meta.cwd) return meta.cwd.split('/').pop() || 'unknown';",
      "if (meta.cwd) return meta.cwd.split(/[\\\\/]/).pop() || 'unknown';",
      "codex extractProject backslash",
    ],
  ]);
  patchFile("src/parsers/qwen-code.js", [
    [
      "const parts = cwd.split('/').filter(Boolean);",
      "const parts = cwd.split(/[\\\\/]/).filter(Boolean);",
      "qwen extractProject backslash",
    ],
  ]);

  // 2. OpenCode on Windows stores data under %LOCALAPPDATA%\opencode.
  patchFile("src/parsers/opencode.js", [
    [
      "const DATA_DIR = join(homedir(), '.local', 'share', 'opencode');",
      `function resolveOpencodeDataDir() {
  const xdg = join(homedir(), '.local', 'share', 'opencode');
  if (process.platform === 'win32' && !existsSync(xdg) && process.env.LOCALAPPDATA) {
    const winDir = join(process.env.LOCALAPPDATA, 'opencode');
    if (existsSync(winDir)) return winDir;
  }
  return xdg;
}
const DATA_DIR = resolveOpencodeDataDir();`,
      "opencode windows data dir",
    ],
  ]);

  // 3. Amp on Windows: %LOCALAPPDATA%\amp\threads (XDG default kept last).
  patchFile("src/parsers/amp.js", [
    [
      "  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, 'amp', 'threads');\n  return join(homedir(), '.local', 'share', 'amp', 'threads');",
      `  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, 'amp', 'threads');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const winDir = join(process.env.LOCALAPPDATA, 'amp', 'threads');
    if (existsSync(winDir)) return winDir;
  }
  return join(homedir(), '.local', 'share', 'amp', 'threads');`,
      "amp windows data dir",
    ],
  ]);

  // 4. Repair accidental directory-at-file-path cases so sync cannot fail
  // with EISDIR when writing config.json / usage.json.
  const eisdirHelpers = `function backupPath(path) {
  return \`\${path}.directory-backup-\${Date.now()}\`;
}

function moveDirectoryOutOfFilePath(path) {
  try {
    if (statSync(path).isDirectory()) {
      renameSync(path, backupPath(path));
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

`;
  patchFile("src/config.js", [
    [
      "import { readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';",
      "import { readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync, renameSync, statSync } from 'node:fs';",
      "config fs helpers",
    ],
    [
      "export function getConfigPath() {",
      `${eisdirHelpers}export function getConfigPath() {`,
      "config EISDIR repair helpers",
    ],
    [
      "  mkdirSync(CONFIG_DIR, { recursive: true });",
      "  mkdirSync(CONFIG_DIR, { recursive: true });\n  moveDirectoryOutOfFilePath(CONFIG_FILE);",
      "config save EISDIR repair",
    ],
  ]);
  patchFile("src/store.js", [
    [
      "import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';",
      "import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';",
      "store fs helpers",
    ],
    [
      "export function getStorePath() {",
      `${eisdirHelpers}export function getStorePath() {`,
      "store EISDIR repair helpers",
    ],
    [
      "  const tempPath = `${STORE_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;",
      "  moveDirectoryOutOfFilePath(STORE_FILE);\n  const tempPath = `${STORE_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;",
      "store save EISDIR repair",
    ],
  ]);
}

// ---------------------------------------------------------------------------

const localFlag = optionValue("--from-local");
const tarballFlag = optionValue("--from-tarball");
if (tarballFlag) {
  vendorFromTarball(tarballFlag);
} else {
  // Offline fork only — never resolve from the npm registry (it carries the
  // online-era CLI that uploads usage to vibecafe.ai).
  vendorFromLocal(localFlag ?? DEFAULT_LOCAL);
}

applyWindowsPatches();

// Guard: the vendored CLI must be the offline fork — it ships the local
// store (src/store.js) and never the online-era uploader (src/api.js).
const pkg = JSON.parse(fs.readFileSync(path.join(destDir, "package.json"), "utf8"));
if (pkg.name !== "@vibe-cafe/vibe-usage" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(pkg.version)) {
  throw new Error(`invalid vendored CLI identity: ${pkg.name}@${pkg.version}`);
}
if (!fs.existsSync(path.join(destDir, "src", "store.js"))) {
  throw new Error("vendored CLI is not the offline fork (missing src/store.js)");
}
if (fs.existsSync(path.join(destDir, "src", "api.js"))) {
  throw new Error("vendored CLI looks like the online-era build (found src/api.js)");
}
log(`vendored offline CLI ${pkg.name}@${pkg.version} → ${path.relative(root, destDir)}`);
