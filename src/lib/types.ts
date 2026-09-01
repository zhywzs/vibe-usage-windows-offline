// Data models — 1:1 port of VibeUsage/Models/*.swift

/** Mirrors UsageBucket.swift */
export interface UsageBucket {
  source: string;
  model: string;
  project: string;
  hostname: string;
  bucketStart: string;
  inputTokens: number;
  outputTokens: number;
  /** Not yet emitted by the sync pipeline; optional so decoding keeps working once it appears. */
  cacheCreationInputTokens?: number | null;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedCost?: number | null;
}

/** input + output + reasoning + cached input — matches the web dashboard totals. */
export function computedTotal(b: UsageBucket): number {
  return b.inputTokens + b.outputTokens + b.reasoningOutputTokens + b.cachedInputTokens;
}

function localDateKey(value: string): string {
  const date = new Date(value);
  if (isNaN(date.getTime())) return value.slice(0, 10);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Local calendar day for grouping, matching the web dashboard's timezone semantics. */
export function bucketDayKey(b: UsageBucket): string {
  return localDateKey(b.bucketStart);
}

/** Hour string (yyyy-MM-ddTHH) for hourly grouping — UTC prefix(13) */
export function bucketHourKey(b: UsageBucket): string {
  return b.bucketStart.slice(0, 13);
}

export function bucketDate(b: UsageBucket): Date | null {
  const d = new Date(b.bucketStart);
  return isNaN(d.getTime()) ? null : d;
}

/** Mirrors UsageSession.swift */
export interface UsageSession {
  source: string;
  project: string;
  hostname: string;
  firstMessageAt: string;
  lastMessageAt: string;
  durationSeconds: number;
  activeSeconds: number;
  messageCount: number;
  userMessageCount: number;
}

export function sessionDayKey(s: UsageSession): string {
  return localDateKey(s.firstMessageAt);
}

export function sessionHourKey(s: UsageSession): string {
  return s.firstMessageAt.slice(0, 13);
}

export function sessionDate(s: UsageSession): Date | null {
  const d = new Date(s.firstMessageAt);
  return isNaN(d.getTime()) ? null : d;
}

export interface UsageResponse {
  buckets: UsageBucket[];
  sessions?: UsageSession[] | null;
  hasAnyData: boolean;
  /** Display currency for cost rendering (estimatedCost stays USD). */
  currency?: CurrencyInfo | null;
}

// ---------------------------------------------------------------------------
// Dashboard controls — 1:1 port of AppState.swift enums

export type ChartMode = "token" | "cost" | "activeTime";

export const CHART_MODE_LABELS: Record<ChartMode, string> = {
  token: "Token",
  cost: "费用",
  activeTime: "活跃",
};

export type TimeRange = "today" | "1D" | "7D" | "30D" | "90D" | "custom";

export const TIME_RANGE_ORDER: TimeRange[] = ["today", "1D", "7D", "30D", "90D", "custom"];

export function timeRangeLabel(r: TimeRange): string {
  switch (r) {
    case "today":
      return "今天";
    case "1D":
      return "24H";
    case "custom":
      return "自定义";
    default:
      return r;
  }
}

export function fixedDayCount(r: TimeRange): number {
  switch (r) {
    case "today":
    case "1D":
      return 1;
    case "7D":
      return 7;
    case "30D":
      return 30;
    case "90D":
      return 90;
    case "custom":
      return 7;
  }
}

/** Hour-granularity for today + rolling 24h; day-granularity for longer ranges. */
export function isHourly(r: TimeRange): boolean {
  return r === "today" || r === "1D";
}

/**
 * Inclusive lower bound on bucket/session timestamps when this range is
 * active. Only `.today` tightens the client-side window below what the API
 * returned (mirrors TimeRange.startCutoff).
 */
export function startCutoff(r: TimeRange, now: Date = new Date()): Date | null {
  if (r !== "today") return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Mirrors FilterState */
export interface FilterState {
  sources: Set<string>;
  models: Set<string>;
  projects: Set<string>;
  hostnames: Set<string>;
}

export function emptyFilters(): FilterState {
  return { sources: new Set(), models: new Set(), projects: new Set(), hostnames: new Set() };
}

export function filtersAreEmpty(f: FilterState): boolean {
  return (
    f.sources.size === 0 && f.models.size === 0 && f.projects.size === 0 && f.hostnames.size === 0
  );
}

// ---------------------------------------------------------------------------
// Rate limits — mirrors RateLimit.swift (serialized from Rust)

export interface RateLimitWindow {
  /** 0-100 */
  utilization: number;
  /** epoch seconds */
  resetsAt?: number | null;
  /** seconds; enables the elapsed-time bar */
  windowDuration?: number | null;
}

export type RateLimitProvider = "codex" | "claudeCode";

export type RateLimitStatus =
  | { kind: "ok" }
  | { kind: "noData" }
  | { kind: "disabled" }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

export interface ProviderRateLimit {
  provider: RateLimitProvider;
  fiveHour?: RateLimitWindow | null;
  sevenDay?: RateLimitWindow | null;
  planLabel?: string | null;
  status: RateLimitStatus;
}

// ---------------------------------------------------------------------------
// Sync state — mirrors SyncStatus (pushed from Rust via `sync-state` event)

export interface SyncState {
  status: "idle" | "syncing" | "success" | "error";
  message?: string | null;
  /** epoch millis of last successful sync */
  lastSyncAt?: number | null;
}

// ---------------------------------------------------------------------------
// App status (from Rust `get_app_status`)

export interface AppStatus {
  configured: boolean;
  version: string;
  isDev: boolean;
  runtimeAvailable: boolean;
  /** Local usage store — all data stays in this file. */
  storePath: string;
  hostname?: string | null;
}

/** App settings persisted by Rust (mirrors UserDefaults keys). */
export interface AppSettings {
  showCostInTray: boolean;
  showTokensInTray: boolean;
  codexRateLimitEnabled: boolean;
  claudeRateLimitEnabled: boolean;
}

export interface UpdateInfo {
  version: string;
  notes?: string | null;
  url: string;
}

/** Query range sent to Rust fetch_usage — mirrors UsageQueryRange */
export type UsageQuery =
  | { kind: "days"; days: number }
  | { kind: "from"; fromIso: string }
  | { kind: "custom"; fromDate: string; toDate: string };

// ---------------------------------------------------------------------------
// Price-table status (from the offline CLI `prices` command)

export interface PricingRefreshState {
  attempted: boolean;
  ok: boolean | null;
  error: string | null;
}

/** Active display currency (all cost math is USD; rendering converts). */
export interface CurrencyInfo {
  code: string;
  rate: number;
  symbol: string;
}

/** A user-defined custom price override. `avg` mode applies one price to
 *  every token category; `detailed` sets per-field prices. Values are in
 *  the entry's currency per million tokens. */
export interface CustomPriceEntry {
  model: string;
  mode: "avg" | "detailed";
  currency: string;
  avgPerM?: number | null;
  inputPerM?: number | null;
  outputPerM?: number | null;
  cacheReadPerM?: number | null;
}

export interface PricingStatus {
  source: "snapshot" | "cache" | "refreshed";
  fetchedAt: string;
  modelCount: number;
  offline: boolean;
  refresh: PricingRefreshState;
  customCount: number;
  custom: CustomPriceEntry[];
  currency: CurrencyInfo;
  /** code → per-USD rate, merged defaults + user overrides. */
  rates: Record<string, number>;
  coverage: {
    usedModelCount: number;
    pricedModels: string[];
    unpricedModels: string[];
  };
}
