#!/usr/bin/env node
// Version consistency gate (counterpart of macOS scripts/check-version.sh):
// App versions must agree, and the vendored CLI must be the OFFLINE fork
// (local store present, online-era uploader absent).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const packageJson = JSON.parse(read("package.json"));
const pkg = packageJson.version;
const tauri = JSON.parse(read("src-tauri/tauri.conf.json")).version;
const cargo = /\[workspace\.package\][^[]*?version\s*=\s*"([^"]+)"/s.exec(read("Cargo.toml"))?.[1];
const vendoredCli = JSON.parse(read("src-tauri/resources/cli/package.json")).version;

console.log(`package.json:     ${pkg}`);
console.log(`tauri.conf.json:  ${tauri}`);
console.log(`Cargo.toml:       ${cargo}`);
console.log(`Vendored CLI:     ${vendoredCli} (offline fork)`);

if (pkg !== tauri || pkg !== cargo) {
  console.error("✗ version mismatch — update all three before releasing");
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(vendoredCli)) {
  console.error("✗ vendored CLI must contain a concrete semantic version");
  process.exit(1);
}
if (!fs.existsSync(path.join(root, "src-tauri/resources/cli/src/store.js"))) {
  console.error("✗ vendored CLI is not the offline fork (missing src/store.js)");
  process.exit(1);
}
if (fs.existsSync(path.join(root, "src-tauri/resources/cli/src/api.js"))) {
  console.error("✗ vendored CLI looks like the online-era build (found src/api.js)");
  process.exit(1);
}
console.log("✓ app versions are consistent and the vendored CLI is the offline fork");
