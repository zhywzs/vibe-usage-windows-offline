import { afterEach, expect, test, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalConfigDir = process.env.VIBE_USAGE_CONFIG_DIR;
const originalStoreDir = process.env.VIBE_USAGE_STORE_DIR;
const originalDev = process.env.VIBE_USAGE_DEV;
const tempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "vibe-usage-cli-"));
  tempDirs.push(dir);
  return dir;
}

async function importWithDirs<T>(path: string, dir: string): Promise<T> {
  process.env.VIBE_USAGE_CONFIG_DIR = dir;
  process.env.VIBE_USAGE_STORE_DIR = dir;
  delete process.env.VIBE_USAGE_DEV;
  vi.resetModules();
  return import(path) as Promise<T>;
}

afterEach(() => {
  for (const [key, value] of [
    ["VIBE_USAGE_CONFIG_DIR", originalConfigDir],
    ["VIBE_USAGE_STORE_DIR", originalStoreDir],
    ["VIBE_USAGE_DEV", originalDev],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  vi.resetModules();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

test("saveConfig repairs a directory occupying config.json", async () => {
  const dir = makeTempDir();
  mkdirSync(join(dir, "config.json"));

  const config = await importWithDirs<typeof import("../src-tauri/resources/cli/src/config.js")>(
    "../src-tauri/resources/cli/src/config.js",
    dir,
  );
  config.saveConfig({ hostname: "offline-pc" });

  const parsed = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"));
  expect(parsed.hostname).toBe("offline-pc");
  expect(readdirSync(dir).some((name) => name.startsWith("config.json.directory-backup-"))).toBe(
    true,
  );
});

test("saveStore repairs a directory occupying usage.json", async () => {
  const dir = makeTempDir();
  mkdirSync(join(dir, "usage.json"));

  const store = await importWithDirs<typeof import("../src-tauri/resources/cli/src/store.js")>(
    "../src-tauri/resources/cli/src/store.js",
    dir,
  );
  store.saveStore({
    buckets: { k: { hash: "h", data: { source: "codex" } } },
    sessions: {},
  });

  const parsed = JSON.parse(readFileSync(join(dir, "usage.json"), "utf-8"));
  expect(parsed.buckets.k.data.source).toBe("codex");
  expect(readdirSync(dir).some((name) => name.startsWith("usage.json.directory-backup-"))).toBe(
    true,
  );
});
