import { loadStore } from './store.js';
import { loadPricing, lookupPrice } from './pricing.js';

// Machine-readable price-table status — tells users (and the desktop app's
// settings view) which price layer is active, how fresh it is, and whether
// the models actually present in the local usage store are covered.
//
//   vibe-usage prices             # current status (does the normal weekly silent refresh)
//   vibe-usage prices --refresh   # force a refresh attempt; failures are reported, not swallowed

export async function runPrices(args = []) {
  const refresh = args.includes('--refresh');
  const { status, table } = await loadPricing({ refresh });

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
    coverage: {
      usedModelCount: usedModels.size,
      pricedModels,
      unpricedModels,
    },
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}
