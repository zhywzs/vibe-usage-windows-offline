import { loadStore } from './store.js';
import {
  loadPricing, lookupPrice, readCustomFileDirect, saveCustomFile, currencyRate,
  currencySymbol, DEFAULT_RATES, fetchCommunityPrices, mergeCommunityPrices,
} from './pricing.js';

// Price-table status + user-defined model prices.
//
//   vibe-usage prices                                 # status
//   vibe-usage prices --refresh                       # force a refresh attempt
//   vibe-usage prices set <model> --avg <p> [--currency CNY]
//   vibe-usage prices set <model> [--input <p>] [--output <p>] [--cache-read <p>] [--currency CNY]
//   vibe-usage prices unset <model>
//   vibe-usage prices currency [CODE]                 # show/set the display currency
//   vibe-usage prices rate [<CODE> <perUSD>]          # show/set exchange rates
//   vibe-usage prices pull [--force] [--url <url>]    # fetch community prices and merge
//
// Custom prices live in ~/.vibe-usage/prices-custom.json. Units are
// per-million tokens in the entry's currency; `--avg` applies one price to
// every token category (input, output, reasoning, cache reads). Internal
// cost math stays in USD via per-currency rates (CNY has a built-in default;
// set others with `prices rate`). The display currency drives summary/usage
// rendering and the desktop app.
//
// `prices pull` downloads the community price file from this project's
// latest GitHub Release (stable /releases/latest/download/ URL — the same
// acquisition pattern the desktop app's updater uses for its manifest) and
// merges it into the local custom file: entries you set yourself win;
// --force lets the remote values overwrite them.

const DETAILED_FLAGS = [
  ['--input', 'input_per_m'],
  ['--output', 'output_per_m'],
  ['--cache-read', 'cache_read_per_m'],
];

const CURRENCY_RE = /^[A-Za-z]{3}$/;

export async function runPrices(args = []) {
  const sub = args[0];
  if (sub === 'set') return runSet(args.slice(1));
  if (sub === 'unset') return runUnset(args.slice(1));
  if (sub === 'currency') return runCurrency(args.slice(1));
  if (sub === 'rate') return runRate(args.slice(1));
  if (sub === 'pull') return runPull(args.slice(1));
  if (sub !== undefined && !sub.startsWith('--')) {
    throw new Error(`Unknown prices subcommand: ${sub}（可用: set / unset / currency / rate / pull）`);
  }
  await emitStatus({ refresh: args.includes('--refresh') });
}

function optionValue(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const v = args[idx + 1];
  if (v === undefined || v.startsWith('--')) {
    throw new Error(`Option ${name} requires a value.`);
  }
  return v;
}

function parsePrice(raw, flag) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${flag} 无效价格: ${raw}（应为非负数字）`);
  }
  return n;
}

function parseCurrency(raw) {
  const code = String(raw || '').trim().toUpperCase();
  if (!CURRENCY_RE.test(code)) {
    throw new Error(`无效货币代码: ${raw}（应为 3 字母代码，如 USD / CNY）`);
  }
  return code;
}

async function runSet(args) {
  let model;
  const updates = {};
  let currency;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--avg') {
      const raw = args[++i];
      if (raw === undefined || raw.startsWith('--')) throw new Error('Option --avg requires a value.');
      updates.avg_per_m = parsePrice(raw, '--avg');
    } else if (arg === '--currency') {
      currency = parseCurrency(args[++i]);
    } else {
      const flag = DETAILED_FLAGS.find(([name]) => name === arg);
      if (flag) {
        const raw = args[++i];
        if (raw === undefined || raw.startsWith('--')) throw new Error(`Option ${arg} requires a value.`);
        updates[flag[1]] = parsePrice(raw, arg);
      } else if (model === undefined) {
        model = arg;
      } else {
        throw new Error(`Unexpected argument: ${arg}`);
      }
    }
  }

  const name = (model ?? '').trim();
  if (!name) {
    throw new Error('Usage: vibe-usage prices set <model> --avg <p> | (--input <p> | --output <p> | --cache-read <p>)... [--currency CODE]');
  }
  const hasAvg = updates.avg_per_m !== undefined;
  const detailedKeys = Object.keys(updates).filter((k) => k !== 'avg_per_m');
  if (!hasAvg && detailedKeys.length === 0) {
    throw new Error('至少提供一个价格: --avg（平均价）或 --input / --output / --cache-read');
  }
  if (hasAvg && detailedKeys.length > 0) {
    throw new Error('--avg 不能与 --input/--output/--cache-read 混用');
  }

  const file = readCustomFileDirect();
  const key = name.toLowerCase();
  const existing = file.models[key] || {};
  const entryCurrency = currency
    ?? (existing.mode === 'avg' || existing.mode === 'detailed' ? existing.currency : undefined)
    ?? 'USD';
  if (currencyRate(entryCurrency, file) === null) {
    throw new Error(`货币 ${entryCurrency} 缺少汇率，请先运行: vibe-usage prices rate ${entryCurrency} <每美元兑${entryCurrency}数值>`);
  }

  if (hasAvg) {
    file.models[key] = { mode: 'avg', currency: entryCurrency, avg_per_m: updates.avg_per_m };
  } else {
    const merged = existing.mode === 'detailed' ? existing : {};
    file.models[key] = {
      mode: 'detailed',
      currency: entryCurrency,
      ...merged,
      ...updates,
    };
  }
  saveCustomFile(file);
  await emitStatus({ local: true });
}

async function runUnset(args) {
  const name = (args[0] ?? '').trim();
  if (!name || args.length > 1) {
    throw new Error('Usage: vibe-usage prices unset <model>');
  }
  const file = readCustomFileDirect();
  delete file.models[name.toLowerCase()];
  saveCustomFile(file);
  await emitStatus({ local: true });
}

async function runCurrency(args) {
  if (args.length === 0) {
    const meta = (await loadPricing({ local: true })).meta;
    process.stdout.write(JSON.stringify({
      code: meta.code,
      rate: meta.rate,
      symbol: meta.symbol,
      hasRate: meta.hasRate,
    }) + '\n');
    return;
  }
  if (args.length > 1) {
    throw new Error('Usage: vibe-usage prices currency [CODE]');
  }
  const code = parseCurrency(args[0]);
  const file = readCustomFileDirect();
  file.currency = code;
  if (currencyRate(code, file) === null && code !== 'USD') {
    file.rates[code] = DEFAULT_RATES[code] ?? 1;
  }
  saveCustomFile(file);
  await emitStatus({ local: true });
}

async function runRate(args) {
  const file = readCustomFileDirect();
  if (args.length === 0) {
    const rates = { ...DEFAULT_RATES, ...file.rates };
    process.stdout.write(JSON.stringify({ rates }) + '\n');
    return;
  }
  if (args.length !== 2) {
    throw new Error('Usage: vibe-usage prices rate <CODE> <每美元兑该货币数值>');
  }
  const code = parseCurrency(args[0]);
  const value = Number(args[1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`无效汇率: ${args[1]}（应为正数字，含义: 1 USD = ? ${code}）`);
  }
  file.rates[code] = value;
  saveCustomFile(file);
  await emitStatus({ local: true });
}

async function runPull(args) {
  const force = args.includes('--force');
  const url = optionValue(args, '--url');
  const positional = args.filter((a) => a !== '--force' && a !== '--url' && a !== url);
  if (positional.length > 0) {
    throw new Error(`Unexpected argument: ${positional[0]}`);
  }

  const community = await fetchCommunityPrices({ url });
  const merge = mergeCommunityPrices(community, { force });
  const { status, table } = await loadPricing({ local: true });

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

  const rawFile = readCustomFileDirect();
  process.stdout.write(JSON.stringify({
    ...status,
    pull: { ...merge, forced: force, url: url ?? null },
    custom: formatCustom(rawFile),
    coverage: {
      usedModelCount: usedModels.size,
      pricedModels,
      unpricedModels,
    },
  }) + '\n');
}

async function emitStatus({ refresh = false, local = false } = {}) {
  const { status, table, meta } = await loadPricing({ refresh, local });

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

  const rawFile = readCustomFileDirect();
  const payload = {
    ...status,
    custom: formatCustom(rawFile),
    coverage: {
      usedModelCount: usedModels.size,
      pricedModels,
      unpricedModels,
    },
  };
  void meta;
  process.stdout.write(JSON.stringify(payload) + '\n');
}

// Custom entries as stored (per-million prices in the entry's currency).
function formatCustom(file) {
  return Object.entries(file.models)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, entry]) => {
      if (entry.mode === 'avg') {
        return {
          model,
          mode: 'avg',
          currency: entry.currency || 'USD',
          avgPerM: entry.avg_per_m ?? null,
        };
      }
      return {
        model,
        mode: 'detailed',
        currency: entry.currency || 'USD',
        inputPerM: entry.input_per_m ?? entry.input_cost_per_token * 1e6 ?? null,
        outputPerM: entry.output_per_m ?? entry.output_cost_per_token * 1e6 ?? null,
        cacheReadPerM: entry.cache_read_per_m ?? entry.cache_read_input_token_cost * 1e6 ?? null,
      };
    });
}
