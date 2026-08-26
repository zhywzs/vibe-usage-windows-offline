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
//
// Set VIBE_USAGE_OFFLINE=1 to never touch the network (cache/snapshot only).
// VIBE_USAGE_PRICES_URL overrides the table URL (test hook); the store-dir
// override VIBE_USAGE_STORE_DIR also relocates the cache file.

const DEFAULT_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const STORE_DIR = process.env.VIBE_USAGE_STORE_DIR?.trim() || join(homedir(), '.vibe-usage');
const CACHE_FILE = join(STORE_DIR, 'prices.json');

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
 */
export async function getPriceTable({ force = false } = {}) {
  const cache = readCache();
  const age = cache ? Date.now() - Date.parse(cache.fetchedAt) : Infinity;
  if (!force && cache && Number.isFinite(age) && age < REFRESH_INTERVAL_MS) {
    return cache;
  }

  if (process.env.VIBE_USAGE_OFFLINE === '1') {
    return cache ?? getSnapshotTable();
  }

  try {
    return await tryRefreshPriceTable();
  } catch {
    return cache ?? getSnapshotTable();
  }
}

// Resolve the price table plus a machine-readable status describing which
// layer is active and — with `refresh` — why a forced attempt did or did not
// succeed. `getPriceTable` stays silent by design; this is the reporting
// surface for `vibe-usage prices` and the desktop settings view.
export async function loadPricing({ refresh = false } = {}) {
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
  } else {
    table = await getPriceTable();
  }

  const status = {
    source: table.source,
    fetchedAt: table.fetchedAt,
    modelCount: Object.keys(table.models).length,
    offline,
    refresh: refreshState,
  };
  return { status, table };
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
