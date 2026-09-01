import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Loaded at runtime (not a JSON import attribute) so every Node >= 20 can run
// the package; import attributes require >= 20.10.
const snapshot = JSON.parse(
  readFileSync(new URL('./prices-snapshot.json', import.meta.url), 'utf-8'),
);

// Offline-first model pricing. Costs are estimated locally from a price
// table; nothing here is required for token statistics to work.
//
// Layers (most recent wins):
//   1. bundled snapshot  src/prices-snapshot.json (works with zero network)
//   2. cached refresh    ~/.vibe-usage/prices.json
//   3. live refresh      best-effort, at most once per week, silent on failure
//   4. custom overrides  ~/.vibe-usage/prices-custom.json (user-managed;
//                        partial entries merge per field with the layers below)
//
// Set VIBE_USAGE_OFFLINE=1 to never touch the network (cache/snapshot only).
// VIBE_USAGE_PRICES_URL overrides the table URL (test hook); the store-dir
// override VIBE_USAGE_STORE_DIR also relocates the cache/custom files.

const DEFAULT_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const STORE_DIR = process.env.VIBE_USAGE_STORE_DIR?.trim() || join(homedir(), '.vibe-usage');
const CACHE_FILE = join(STORE_DIR, 'prices.json');
const CUSTOM_FILE = join(STORE_DIR, 'prices-custom.json');

const CUSTOM_FIELDS = [
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_read_input_token_cost',
];

export function getSnapshotTable() {
  return {
    fetchedAt: snapshot.fetchedAt,
    models: snapshot.models,
    source: 'snapshot',
  };
}

function readCache() {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.models) return null;
    if (typeof parsed.fetchedAt !== 'string') return null;
    return { fetchedAt: parsed.fetchedAt, models: parsed.models, source: 'cache' };
  } catch {
    return null;
  }
}

function writeCache(models, fetchedAt) {
  try {
    mkdirSync(STORE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt, models }) + '\n', 'utf-8');
  } catch {
    // A read-only home must never break sync/summary — keep using the layers
    // we already have in memory.
  }
}

async function fetchTable(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const table = await res.json();
  if (!table || typeof table !== 'object') throw new Error('invalid price table');
  const models = {};
  for (const [key, entry] of Object.entries(table)) {
    if (key === 'sample_spec') continue;
    const trimmed = {};
    let priced = false;
    for (const field of [
      'input_cost_per_token',
      'output_cost_per_token',
      'cache_read_input_token_cost',
      'cache_creation_input_token_cost',
    ]) {
      const v = Number(entry?.[field]);
      if (Number.isFinite(v) && v > 0) {
        trimmed[field] = v;
        priced = true;
      }
    }
    if (priced) models[key.toLowerCase()] = trimmed;
  }
  return models;
}

// Force one refresh attempt. Throws on failure (the caller decides whether
// that is silent or user-visible); writes the cache on success.
export async function tryRefreshPriceTable() {
  const url = process.env.VIBE_USAGE_PRICES_URL?.trim() || DEFAULT_URL;
  const models = await fetchTable(url);
  const fetchedAt = new Date().toISOString();
  writeCache(models, fetchedAt);
  return { fetchedAt, models, source: 'refreshed' };
}

/**
 * Resolve the price table, refreshing the cache when stale (best-effort).
 * Never throws: network failure degrades to cache, then to the snapshot.
 * Custom overrides are layered on top of whatever resolves.
 */
export async function getPriceTable({ force = false } = {}) {
  const cache = readCache();
  const age = cache ? Date.now() - Date.parse(cache.fetchedAt) : Infinity;
  if (!force && cache && Number.isFinite(age) && age < REFRESH_INTERVAL_MS) {
    return withCustomPrices(cache);
  }

  if (process.env.VIBE_USAGE_OFFLINE === '1') {
    return withCustomPrices(cache ?? getSnapshotTable());
  }

  try {
    return withCustomPrices(await tryRefreshPriceTable());
  } catch {
    return withCustomPrices(cache ?? getSnapshotTable());
  }
}

// ── Custom price overrides ──────────────────────────────────────────────

// User-defined overrides, keyed by lowercase model name. Values use the same
// per-token schema as the price table. A corrupt file must never break cost
// estimation — it is ignored.
export function loadCustomPrices() {
  try {
    if (!existsSync(CUSTOM_FILE)) return {};
    const parsed = JSON.parse(readFileSync(CUSTOM_FILE, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const entry = {};
      for (const field of CUSTOM_FIELDS) {
        const n = Number(value[field]);
        if (Number.isFinite(n) && n >= 0) entry[field] = n;
      }
      if (Object.keys(entry).length > 0) out[String(key).trim().toLowerCase()] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveCustomPrices(custom) {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(CUSTOM_FILE, JSON.stringify(custom, null, 2) + '\n', 'utf-8');
}

// Layer custom overrides over a resolved table. Partial entries merge per
// field, so overriding just an output price keeps the base input/cache rates.
function withCustomPrices(table) {
  const custom = loadCustomPrices();
  if (Object.keys(custom).length === 0) return table;
  const models = { ...table.models };
  for (const [name, entry] of Object.entries(custom)) {
    models[name] = { ...models[name], ...entry };
  }
  return { ...table, models };
}

// Resolve the price table plus a machine-readable status describing which
// layer is active and — with `refresh` — why a forced attempt did or did not
// succeed. `getPriceTable` stays silent by design; this is the reporting
// surface for `vibe-usage prices` and the desktop settings view.
// `local: true` skips the stale-cache refresh attempt (used right after
// set/unset so saving a price never waits on the network).
export async function loadPricing({ refresh = false, local = false } = {}) {
  const offline = process.env.VIBE_USAGE_OFFLINE === '1';
  const refreshState = { attempted: false, ok: null, error: null };

  let table;
  if (refresh) {
    refreshState.attempted = true;
    if (offline) {
      refreshState.ok = false;
      refreshState.error = 'offline mode (VIBE_USAGE_OFFLINE=1)';
      table = readCache() ?? getSnapshotTable();
    } else {
      try {
        table = await tryRefreshPriceTable();
        refreshState.ok = true;
      } catch (err) {
        refreshState.ok = false;
        refreshState.error = err?.message || String(err);
        table = readCache() ?? getSnapshotTable();
      }
    }
  } else if (local) {
    table = readCache() ?? getSnapshotTable();
  } else {
    table = await getPriceTable();
  }

  const custom = loadCustomPrices();
  const effective = withCustomPrices(table);
  const status = {
    source: table.source,
    fetchedAt: table.fetchedAt,
    modelCount: Object.keys(effective.models).length,
    offline,
    refresh: refreshState,
    customCount: Object.keys(custom).length,
  };
  return { status, table: effective, custom };
}

export async function getPricingStatus(opts = {}) {
  const { status } = await loadPricing(opts);
  return status;
}

// ── Model-name matching ───────────────────────────────────────────────
// Logs contain wildly inconsistent names: `anthropic/claude-sonnet-4-5`,
// `claude-sonnet-4-5-20250929`, `claude-4-5-sonnet`, `deepseek/deepseek-chat`.
// Try progressively looser normalizations; exact keys are always preferred.

function normalizeModelName(name) {
  return String(name || '').trim().toLowerCase();
}

function stripDateSuffix(name) {
  return name.replace(/-(\d{8})$/, '');
}

// `claude-4-5-sonnet` → `claude-sonnet-4-5` (vendors emit both orders)
function swapVariantPosition(name) {
  const m = name.match(/^(claude)-(\d+(?:[.-]\d+)*)-(sonnet|opus|haiku)$/);
  return m ? `${m[1]}-${m[3]}-${m[2].replace(/\./g, '-')}` : null;
}

export function lookupPrice(models, modelName) {
  const name = normalizeModelName(modelName);
  if (!name) return null;

  const bare = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  const candidates = [name, bare, stripDateSuffix(bare)];
  const swapped = swapVariantPosition(bare) || swapVariantPosition(stripDateSuffix(bare));
  if (swapped) candidates.push(swapped, stripDateSuffix(swapped));

  for (const candidate of candidates) {
    const entry = models[candidate];
    if (entry) return entry;
  }

  // Last resort: the bare name is a prefix of a known key (`kimi-k2` →
  // `kimi-k2-0711-preview`). Pick the shortest match to avoid dating bias.
  let best = null;
  for (const key of Object.keys(models)) {
    if (key.startsWith(`${bare}-`) && (!best || key.length < best.length)) best = key;
  }
  return best ? models[best] : null;
}

/**
 * Estimate a bucket's cost in USD from per-token prices.
 * Parsers keep reasoning separate from output (see AGENTS.md), and reasoning
 * is billed at the output rate. Returns null when the model has no price.
 */
export function estimateBucketCost(models, bucket) {
  const price = lookupPrice(models, bucket.model);
  if (!price) return null;
  const inCost = (bucket.inputTokens || 0) * (price.input_cost_per_token || 0);
  const outCost = (bucket.outputTokens || 0) * (price.output_cost_per_token || 0);
  const reasoningCost = (bucket.reasoningOutputTokens || 0) * (price.output_cost_per_token || 0);
  const cacheCost = (bucket.cachedInputTokens || 0) * (price.cache_read_input_token_cost || 0);
  return inCost + outCost + reasoningCost + cacheCost;
}
