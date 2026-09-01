import { loadStore } from './store.js';
import { loadPricing, lookupPrice, loadCustomPrices, saveCustomPrices } from './pricing.js';

// Price-table status + user-defined model prices.
//
//   vibe-usage prices                          # status (silent weekly refresh rules)
//   vibe-usage prices --refresh                # force a refresh attempt, report the outcome
//   vibe-usage prices set <model> [--input <$/M>] [--output <$/M>] [--cache-read <$/M>]
//   vibe-usage prices unset <model>
//
// Custom prices live in ~/.vibe-usage/prices-custom.json and layer over the
// resolved table (snapshot/cache/refresh): a partial entry merges per field,
// so overriding just an output price keeps the base input/cache rates. Units
// are USD per million tokens ($/M) — what pricing pages quote — converted to
// per-token internally.

const PRICE_FLAGS = [
  ['--input', 'input_cost_per_token'],
  ['--output', 'output_cost_per_token'],
  ['--cache-read', 'cache_read_input_token_cost'],
];

export async function runPrices(args = []) {
  const sub = args[0];
  if (sub === 'set') {
    await runSet(args.slice(1));
    return;
  }
  if (sub === 'unset') {
    await runUnset(args.slice(1));
    return;
  }
  if (sub !== undefined && !sub.startsWith('--')) {
    throw new Error(`Unknown prices subcommand: ${sub}（可用: set / unset）`);
  }
  await emitStatus({ refresh: args.includes('--refresh') });
}

async function runSet(args) {
  let model;
  const updates = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const flag = PRICE_FLAGS.find(([name]) => name === arg);
    if (flag) {
      const raw = args[++i];
      if (raw === undefined || raw.startsWith('--')) {
        throw new Error(`Option ${arg} requires a value.`);
      }
      updates[flag[1]] = parsePerMillion(raw, arg);
    } else if (model === undefined) {
      model = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  const name = (model ?? '').trim();
  if (!name) {
    throw new Error('Usage: vibe-usage prices set <model> [--input <$/M>] [--output <$/M>] [--cache-read <$/M>]');
  }
  if (Object.keys(updates).length === 0) {
    throw new Error('至少提供一个价格选项: --input / --output / --cache-read（单位: 美元/百万 tokens）');
  }
  const key = name.toLowerCase();
  const custom = loadCustomPrices();
  custom[key] = { ...(custom[key] || {}), ...updates };
  saveCustomPrices(custom);
  await emitStatus({ local: true });
}

async function runUnset(args) {
  const name = (args[0] ?? '').trim();
  if (!name || args.length > 1) {
    throw new Error('Usage: vibe-usage prices unset <model>');
  }
  const custom = loadCustomPrices();
  delete custom[name.toLowerCase()];
  saveCustomPrices(custom);
  await emitStatus({ local: true });
}

function parsePerMillion(raw, flag) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${flag} 无效价格: ${raw}（应为非负数字，单位: 美元/百万 tokens）`);
  }
  return n / 1_000_000;
}

async function emitStatus({ refresh = false, local = false } = {}) {
  const { status, table, custom } = await loadPricing({ refresh, local });

  const usedModels = new Set();
  for (const entry of Object.values(loadStore().buckets)) {
    const model = entry.data?.model;
    if (model) usedModels.add(model);
  }
  const pricedModels = [];
  const unpricedModels = [];
  for (const model of usedModels) {
    (lookupPrice(table.models, model) ? pricedModels : unpricedModels).push(model);
  }
  pricedModels.sort();
  unpricedModels.sort();

  const payload = {
    ...status,
    custom: formatCustom(custom),
    coverage: {
      usedModelCount: usedModels.size,
      pricedModels,
      unpricedModels,
    },
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

// Custom entries re-expressed in $/M for display and management UIs.
function formatCustom(custom) {
  const toPerM = (v) => (v == null ? null : Math.round(v * 1e6 * 1e8) / 1e8);
  return Object.entries(custom)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, entry]) => ({
      model,
      inputPerM: toPerM(entry.input_cost_per_token),
      outputPerM: toPerM(entry.output_cost_per_token),
      cacheReadPerM: toPerM(entry.cache_read_input_token_cost),
    }));
}
