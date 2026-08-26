import { hostname as osHostname } from 'node:os';
import { loadConfig, saveConfig } from './config.js';
import {
  loadStore, saveStore, pruneStore, mergeIntoStore,
  bucketKey, bucketHash, sessionKey, sessionHash,
} from './store.js';
import { parsers } from './parsers/index.js';
import { normalizeParserResult } from './parsers/contract.js';
import { success, dim } from './output.js';

export function resolveCodexExtraHome(configured, temporary) {
  return temporary ?? configured;
}

// Parser execution is I/O bound (log reads, SQLite snapshots). Run a bounded
// number at once to cut wall-clock sync time without the memory spike of
// loading every tool's logs simultaneously.
export const PARSER_CONCURRENCY = 4;

// Run `fn` over `items` with at most `limit` in flight, preserving order.
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runSync({
  quiet = false,
  surface = 'cli',
  codexExtraHome,
} = {}) {
  // surface is accepted for call-site compatibility (daemon passes 'daemon');
  // with no upload step there is nothing to differentiate anymore.
  void surface;

  const config = loadConfig() || {};

  // Migration: remove deprecated fields left over from the online era.
  let configDirty = false;
  for (const legacy of ['lastSync', 'apiKey', 'apiUrl', 'lastUploadProject', 'lastUploadProjectApiUrl']) {
    if (legacy in config) {
      delete config[legacy];
      configDirty = true;
    }
  }
  if (configDirty) saveConfig(config);

  let allBuckets = [];
  const allSessions = [];
  const parserResults = [];
  const parserProgress = [];
  // Sources whose parser ran to completion this sync. pruneStore() below is
  // scoped to these so a transient parser failure doesn't evict that tool's
  // history from the local store.
  const okSources = new Set();

  // Run parsers concurrently (bounded) so one slow parser (a cold Codex
  // index) can't stall the rest. Results are collected in registry order so
  // output and merged arrays stay deterministic.
  const parserOutcomes = await mapWithConcurrency(
    Object.entries(parsers),
    PARSER_CONCURRENCY,
    async ([source, parse]) => {
      try {
        const result = source === 'codex'
          ? await parse({ codexExtraHome: resolveCodexExtraHome(config.codexExtraHome, codexExtraHome) })
          : await parse();
        return { source, result };
      } catch (err) {
        return { source, error: err };
      }
    },
  );

  for (const { source, result, error } of parserOutcomes) {
    if (error) {
      // Parser errors are non-fatal — pass-through in dim gray (no translation).
      process.stderr.write(`${dim(`  ${source}: ${error.message}`)}\n`);
      continue;
    }
    let normalized;
    try {
      normalized = normalizeParserResult(source, result);
    } catch (err) {
      process.stderr.write(`${dim(`  ${source}: ${err.message}`)}\n`);
      continue;
    }
    const { buckets, sessions, skipped, warnings, indexing } = normalized;
    if (indexing) {
      parserProgress.push({ source, ...indexing });
    }
    for (const message of warnings) {
      process.stderr.write(`${dim(`  ${message}`)}\n`);
    }
    // A parser may deliberately suppress a transient error to keep daemon
    // logs quiet. Its empty result is not proof that its prior data
    // disappeared, so it must not be pruned this run.
    if (!skipped) okSources.add(source);
    if (buckets.length > 0) allBuckets.push(...buckets);
    if (sessions.length > 0) allSessions.push(...sessions);
    if (buckets.length > 0 || sessions.length > 0) {
      parserResults.push({ source, buckets: buckets.length, sessions: sessions.length });
    }
  }

  if (!quiet && parserResults.length > 0) {
    for (const p of parserResults) {
      const parts = [];
      if (p.buckets > 0) parts.push(`${p.buckets} buckets`);
      if (p.sessions > 0) parts.push(`${p.sessions} sessions`);
      console.log(`  ${dim(p.source.padEnd(14))}${parts.join(' · ')}`);
    }
  }
  if (!quiet && parserProgress.length > 0) {
    for (const p of parserProgress) {
      console.log(dim(`  ${p.source}: 正在建立本地索引 ${p.completed}/${p.total}（下次同步继续）`));
    }
  }

  // Stable hostname: captured once and reused, so macOS mDNS drift (e.g.
  // `-2` suffixes) can't fork one machine's history into two identities.
  let host = config.hostname;
  if (!host) {
    host = osHostname().replace(/\.local$/, '');
    config.hostname = host;
    saveConfig(config);
  }
  for (const b of allBuckets) if (!b.hostname) b.hostname = host;
  for (const s of allSessions) if (!s.hostname) s.hostname = host;

  // Incremental merge into the local store: parsers above emit a complete
  // view of live local data (Codex may assemble that view from its
  // disposable parser cache). Here we keep only items that are new or
  // changed since the last successful merge — a quiet machine writes
  // nothing. Missing/corrupt usage.json => empty maps => one-time full
  // import, then incremental forever after.
  const store = loadStore();
  const liveBucketKeys = new Set();
  const liveSessionKeys = new Set();
  const changedBuckets = [];
  const changedSessions = [];

  for (const b of allBuckets) {
    const key = bucketKey(b);
    liveBucketKeys.add(key);
    const existing = store.buckets[key];
    if (existing && existing.hash === bucketHash(b)) continue;
    changedBuckets.push(b);
  }
  for (const s of allSessions) {
    const key = sessionKey(s);
    liveSessionKeys.add(key);
    const existing = store.sessions[key];
    if (existing && existing.hash === sessionHash(s)) continue;
    changedSessions.push(s);
  }

  // Drop entries the parsers no longer emit (deleted logs) so usage.json
  // can't grow forever. Done by liveness, never by age — an old bucket's
  // hash never changes, so keeping it is exactly what preserves history once
  // the raw log is gone. Scoped to sources whose parser succeeded this run.
  const before = Object.keys(store.buckets).length + Object.keys(store.sessions).length;
  pruneStore(store, liveBucketKeys, liveSessionKeys, okSources);
  const pruned = before - (Object.keys(store.buckets).length + Object.keys(store.sessions).length);

  const { newBuckets, updatedBuckets, newSessions, updatedSessions } =
    mergeIntoStore(store, changedBuckets, changedSessions);

  if (newBuckets + updatedBuckets + newSessions + updatedSessions > 0 || pruned > 0) {
    saveStore(store);
  }

  if (!quiet) {
    if (newBuckets + updatedBuckets + newSessions + updatedSessions === 0) {
      if (parserProgress.length === 0) console.log(dim('暂无新数据。'));
    } else {
      const parts = [];
      if (newBuckets > 0 || updatedBuckets > 0) {
        parts.push(`${newBuckets + updatedBuckets} buckets`);
      }
      if (newSessions > 0 || updatedSessions > 0) {
        parts.push(`${newSessions + updatedSessions} sessions`);
      }
      console.log(success(`已入库 ${parts.join(' · ')}`));
    }

    if (newSessions + updatedSessions > 0) {
      const totalActive = changedSessions.reduce((s, x) => s + x.activeSeconds, 0);
      const totalDuration = changedSessions.reduce((s, x) => s + x.durationSeconds, 0);
      const totalMsgs = changedSessions.reduce((s, x) => s + x.messageCount, 0);
      const fmtTime = (secs) => {
        if (secs < 60) return `${secs}s`;
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
      };
      console.log(dim(`  活跃 ${fmtTime(totalActive)} / 总时长 ${fmtTime(totalDuration)} · ${totalMsgs} 条消息`));
    }
    console.log();
  }

  return newBuckets + updatedBuckets;
}
