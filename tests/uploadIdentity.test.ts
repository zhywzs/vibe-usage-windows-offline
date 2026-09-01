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
  expect(source).toContain('vec!["usage".to_string()]');
  expect(source).not.toContain("/api/usage");
  expect(existsSync("src-tauri/src/services/api_client.rs")).toBe(false);
  expect(existsSync("src-tauri/src/services/device_link.rs")).toBe(false);
});

test("pricing status is served by the vendored CLI with refresh reporting", () => {
  const reader = readFileSync("src-tauri/src/services/usage_reader.rs", "utf-8");
  expect(reader).toContain('vec!["prices".to_string()]');
  expect(reader).toContain('"--refresh"');
  const commands = readFileSync("src-tauri/src/commands.rs", "utf-8");
  expect(commands).toContain("get_pricing_status");
  // The vendored CLI must ship the prices command the Rust bridge spawns.
  expect(existsSync("src-tauri/resources/cli/src/prices.js")).toBe(true);
  const settings = readFileSync("src/SettingsApp.tsx", "utf-8");
  expect(settings).toContain("getPricingStatus");
  expect(settings).toContain("模型覆盖");
});

test("custom model prices flow through the CLI bridge and the settings UI", () => {
  const commands = readFileSync("src-tauri/src/commands.rs", "utf8");
  expect(commands).toContain("set_custom_price");
  expect(commands).toContain("remove_custom_price");
  expect(commands).toContain("set_display_currency");
  expect(commands).toContain("set_currency_rate");
  const reader = readFileSync("src-tauri/src/services/usage_reader.rs", "utf8");
  expect(reader).toContain('"set".to_string()');
  expect(reader).toContain('"unset".to_string()');
  expect(reader).toContain('"currency".to_string()');
  expect(reader).toContain('"rate".to_string()');
  // The vendored CLI implements the custom-price store behind those args.
  const cliPricing = readFileSync("src-tauri/resources/cli/src/pricing.js", "utf8");
  expect(cliPricing).toContain("prices-custom.json");
  const cliPrices = readFileSync("src-tauri/resources/cli/src/prices.js", "utf8");
  expect(cliPrices).toContain("parsePrice");
  expect(cliPrices).toContain("--avg");
  expect(cliPrices).toContain("--currency");
  const settings = readFileSync("src/SettingsApp.tsx", "utf8");
  expect(settings).toContain("setCustomPrice");
  expect(settings).toContain("removeCustomPrice");
  expect(settings).toContain("setDisplayCurrency");
  expect(settings).toContain("显示货币");
  const api = readFileSync("src/lib/api.ts", "utf8");
  expect(api).toContain("set_custom_price");
  expect(api).toContain("set_display_currency");
});
