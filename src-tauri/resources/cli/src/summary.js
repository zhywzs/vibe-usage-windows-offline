import { loadStore, getStorePath } from './store.js';
import { getPriceTable, estimateBucketCost, getPricingMeta } from './pricing.js';

export async function runSummary(args = []) {
  const days = parseDays(args);
  const currencyArg = parseCurrencyArg(args);
  const store = loadStore();
  const prices = await getPriceTable();
  const meta = getPricingMeta({ currency: currencyArg });
  console.log(render(store, prices, days, meta));
}

export function parseCurrencyArg(args) {
  const idx = args.findIndex(a => a === '--currency');
  if (idx === -1) return undefined;
  const v = args[idx + 1];
  if (v === undefined || v.startsWith('--')) {
    throw new Error('Option --currency requires a value (e.g. CNY).');
  }
  return v;
}

export function parseDays(args) {
  const idx = args.findIndex(a => a === '--days');
  if (idx === -1) return 7;
  const v = parseInt(args[idx + 1], 10);
  if (!v || v < 1) return 7;
  if (v > 90) return 90;
  return v;
}

export function render(store, prices, days, meta = { code: 'USD', rate: 1, symbol: '$' }) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const buckets = Object.values(store.buckets)
    .map(entry => entry.data)
    .filter(b => b.bucketStart >= cutoff);
  const sessions = Object.values(store.sessions)
    .map(entry => entry.data)
    .filter(s => (s.lastMessageAt || '') >= cutoff);

  const fmtCost = (usd) => `${meta.symbol}${(usd * meta.rate).toFixed(2)}`;

  if (buckets.length === 0) {
    return `# Vibe Usage Summary (Last ${days} ${days === 1 ? 'day' : 'days'})\n\n暂无数据。运行 \`npx @vibe-cafe/vibe-usage sync\` 从本地日志统计 token 用量。\n`;
  }

  let totalCost = 0;
  let totalTokens = 0;
  let unpricedTokens = 0;
  const hasPricing = Object.keys(prices.models).length > 0;
  const byModel = new Map();
  const byProject = new Map();

  for (const b of buckets) {
    const cost = hasPricing ? estimateBucketCost(prices.models, b) : null;
    const priced = cost !== null;
    if (priced) totalCost += cost;
    else unpricedTokens += Number(b.totalTokens ?? 0);
    const tokens = Number(b.totalTokens ?? 0);
    totalTokens += tokens;
    accumulate(byModel, b.model, { cost: priced ? cost : 0, tokens, priced });
    accumulate(byProject, b.project || 'unknown', { cost: priced ? cost : 0, tokens, sessions: 0 });
  }

  let activeSeconds = 0;
  for (const s of sessions) {
    activeSeconds += Number(s.activeSeconds ?? 0);
    const proj = byProject.get(s.project || 'unknown');
    if (proj) proj.sessions += 1;
  }
  const activeHours = activeSeconds / 3600;

  const lines = [];
  lines.push(`# Vibe Usage Summary (Last ${days} ${days === 1 ? 'day' : 'days'})`);
  lines.push('');
  lines.push(`**总览**: ${fmtCost(totalCost)} · ${formatTokens(totalTokens)} tokens · ${sessions.length} sessions · ${activeHours.toFixed(1)}h active`);
  lines.push('');

  lines.push('## 按模型');
  lines.push('');
  lines.push('| 模型 | 费用 | Tokens | 占比 |');
  lines.push('|---|---:|---:|---:|');
  for (const [model, { cost, tokens }] of topN(byModel, 'cost', 8)) {
    const pct = totalCost > 0 ? ((cost / totalCost) * 100).toFixed(0) : '0';
    lines.push(`| ${model} | ${fmtCost(cost)} | ${formatTokens(tokens)} | ${pct}% |`);
  }
  lines.push('');

  lines.push('## 按项目');
  lines.push('');
  lines.push('| 项目 | 费用 | Sessions |');
  lines.push('|---|---:|---:|');
  for (const [project, { cost, sessions: ss }] of topN(byProject, 'cost', 8)) {
    lines.push(`| ${project} | ${fmtCost(cost)} | ${ss} |`);
  }
  lines.push('');

  if (unpricedTokens > 0) {
    lines.push(`> 另有 ${formatTokens(unpricedTokens)} tokens 的模型无价格数据，未计入费用。`);
    lines.push('');
  }
  lines.push(`数据: ${getStorePath()} · 价格表更新于 ${prices.fetchedAt?.slice(0, 10) || 'unknown'}（本地估算，仅供参考${meta.code !== 'USD' ? `，汇率 1 USD = ${meta.rate} ${meta.code}` : ''}）`);
  return lines.join('\n');
}

function accumulate(map, key, delta) {
  const cur = map.get(key) || { cost: 0, tokens: 0, sessions: 0, priced: true };
  for (const k of Object.keys(delta)) {
    if (k === 'priced') cur.priced = cur.priced && delta.priced;
    else cur[k] = (cur[k] || 0) + delta[k];
  }
  map.set(key, cur);
}

function topN(map, sortBy, n) {
  return [...map.entries()]
    .sort((a, b) => b[1][sortBy] - a[1][sortBy])
    .slice(0, n);
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}
