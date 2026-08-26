import { expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";

test("the vendored CLI is the offline fork", () => {
  // Local store present, online-era uploader absent.
  expect(existsSync("src-tauri/resources/cli/src/store.js")).toBe(true);
  expect(existsSync("src-tauri/resources/cli/src/pricing.js")).toBe(true);
  expect(existsSync("src-tauri/resources/cli/src/api.js")).toBe(false);
  expect(existsSync("src-tauri/resources/cli/src/client-meta.js")).toBe(false);
  expect(existsSync("src-tauri/resources/cli/src/parsers/cursor.js")).toBe(false);
});

test("Tauri sync no longer injects the online-era upload-surface envs", () => {
  const source = readFileSync("src-tauri/src/services/sync_engine.rs", "utf-8");
  expect(source).not.toContain("VIBE_USAGE_SURFACE");
  // Offline identity envs must point the CLI's config/store at the shared dir.
  expect(source).toContain('"VIBE_USAGE_CONFIG_DIR"');
  expect(source).toContain('"VIBE_USAGE_STORE_DIR"');
});

test("vendoring never resolves the CLI from the npm registry", () => {
  const vendorScript = readFileSync("scripts/vendor-cli.mjs", "utf-8");
  expect(vendorScript).not.toContain("npm pack");
  expect(vendorScript).toContain("vendorFromLocal");
  // And the release gate enforces the offline fork.
  const gate = readFileSync("scripts/check-version.mjs", "utf-8");
  expect(gate).toContain("missing src/store.js");
  expect(gate).toContain("found src/api.js");
});

test("usage queries stay local — fetch spawns the CLI, not an HTTP endpoint", () => {
  const source = readFileSync("src-tauri/src/services/usage_reader.rs", "utf-8");
  expect(source).toContain('.arg("usage")');
  expect(source).not.toContain("/api/usage");
  expect(existsSync("src-tauri/src/services/api_client.rs")).toBe(false);
  expect(existsSync("src-tauri/src/services/device_link.rs")).toBe(false);
});
