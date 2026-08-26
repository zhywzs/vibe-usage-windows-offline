import { loadStore } from './store.js';
import { getPriceTable, estimateBucketCost } from './pricing.js';

// Machine-readable local usage query — the offline replacement for the
// vibecafe.ai GET /api/usage endpoint. Emits JSON to stdout in the exact
// shape the desktop apps' UsageResponse expects (buckets carry estimatedCost;
// hasAnyData reports whether the whole store has anything at all, driving the
// dashboard's "no data yet" state instead of the current window's emptiness).
//
//   vibe-usage usage [--days N | --from <ISO> | --from-date <Y-M-D> --to-date <Y-M-D>]
//
// The desktop frontend groups buckets/sessions into local calendar days
// itself, so ranges here are simple timestamp filters:
//   --days N      rolling window of the last N*24h
//   --from ISO    from the given instant to now
//   --from-date/--to-date  local-calendar-day bounds (inclusive)

export async function runUsage(args = []) {
  const range = parseRange(args);
  const store = loadStore();
  const prices = await getPriceTable();
  const hasPricing = Object.keys(prices.models).length > 0;

  const cutoff = range.from ?? new Date(0).toISOString();
  const toCutoff = range.to ?? new Date(Date.now() + 60_000).toISOString();

  const buckets = Object.values(store.buckets)
    .map(entry => entry.data)
    .filter(b => b.bucketStart >= cutoff && b.bucketStart <= toCutoff)
    .sort((a, b) => (a.bucketStart < b.bucketStart ? -1 : a.bucketStart > b.bucketStart ? 1 : 0))
    .map(b => ({
      ...b,
      estimatedCost: hasPricing ? estimateBucketCost(prices.models, b) : null,
    }));

  const sessions = Object.values(store.sessions)
    .map(entry => entry.data)
    .filter(s => {
      const last = s.lastMessageAt || '';
      return last >= cutoff && last <= toCutoff;
    })
    .sort((a, b) => (a.firstMessageAt < b.firstMessageAt ? -1 : a.firstMessageAt > b.firstMessageAt ? 1 : 0))
    .map(({ userPromptHours, ...s }) => s);

  const payload = {
    buckets,
    sessions,
    hasAnyData: Object.keys(store.buckets).length > 0,
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function optionValue(args, name) {
  const flag = `--${name}`;
  const idx = args.findIndex(a => a === flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Option ${flag} requires a value.`);
  }
  return value;
}

// Local-calendar-day → ISO instant: "2026-08-26" interpreted in the machine's
// local timezone (start of day / end of day), matching how the desktop UI
// intends custom-range day picks. Never use `new Date("Y-M-D")` — that parses
// as UTC midnight and shifts the window for non-UTC users.
function localDayStart(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey || '');
  if (!m) throw new Error(`Invalid date: ${dayKey} (expected YYYY-MM-DD)`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${dayKey}`);
  return d;
}

export function parseRange(args) {
  const days = optionValue(args, 'days');
  const from = optionValue(args, 'from');
  const fromDate = optionValue(args, 'from-date');
  const toDate = optionValue(args, 'to-date');

  const provided = [days, from, fromDate].filter(v => v !== undefined).length;
  if (provided > 1) {
    throw new Error('Options --days, --from, --from-date are mutually exclusive.');
  }
  if ((fromDate === undefined) !== (toDate === undefined)) {
    throw new Error('Options --from-date and --to-date must be used together.');
  }

  if (days !== undefined) {
    const n = Number(days);
    if (!Number.isFinite(n) || n < 1 || n > 3650) {
      throw new Error(`Invalid --days value: ${days}`);
    }
    return { from: new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString() };
  }
  if (from !== undefined) {
    const t = Date.parse(from);
    if (isNaN(t)) throw new Error(`Invalid --from ISO datetime: ${from}`);
    return { from: new Date(t).toISOString() };
  }
  if (fromDate !== undefined) {
    const start = localDayStart(fromDate);
    const end = localDayStart(toDate);
    end.setHours(23, 59, 59, 999);
    if (start > end) throw new Error('--from-date must not be after --to-date');
    return { from: start.toISOString(), to: end.toISOString() };
  }
  return { from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() };
}
