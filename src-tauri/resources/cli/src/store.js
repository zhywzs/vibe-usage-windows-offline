import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';

// Local usage store — the offline replacement for both the remote dashboard
// database and the old state.json upload ledger. Parsers stay stateless (they
// re-parse local logs every run); this file keeps one authoritative copy of
// every bucket/session ever recorded, keyed and content-hashed so unchanged
// items are recognized without rewriting them.
// VIBE_USAGE_STORE_DIR overrides the dir (test hook).
const STORE_DIR = process.env.VIBE_USAGE_STORE_DIR?.trim() || join(homedir(), '.vibe-usage');
const isDev = process.env.VIBE_USAGE_DEV === '1';
const STORE_FILE = join(STORE_DIR, isDev ? 'usage.dev.json' : 'usage.json');

function backupPath(path) {
  return `${path}.directory-backup-${Date.now()}`;
}

function moveDirectoryOutOfFilePath(path) {
  try {
    if (statSync(path).isDirectory()) {
      renameSync(path, backupPath(path));
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

export function getStorePath() {
  return STORE_FILE;
}

export function loadStore() {
  if (!existsSync(STORE_FILE)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf-8'));
    return {
      buckets: parsed.buckets ?? {},
      sessions: parsed.sessions ?? {},
    };
  } catch {
    // Corrupt/unreadable store must not lose data silently — treat as empty,
    // which triggers a one-time rebuild from local logs (same as a fresh
    // install; the raw tool logs remain the source of truth).
    return emptyStore();
  }
}

export function emptyStore() {
  return { buckets: {}, sessions: {} };
}

export function saveStore(store) {
  mkdirSync(STORE_DIR, { recursive: true });
  // Atomic replace: write to a unique temp file then rename over the target.
  // A crash mid-write can no longer truncate usage.json into an unreadable
  // file that loadStore() would treat as empty.
  moveDirectoryOutOfFilePath(STORE_FILE);
  const tempPath = `${STORE_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(store) + '\n', 'utf-8');
    renameSync(tempPath, STORE_FILE);
  } finally {
    // No-op after a successful rename; cleans up the partial write if
    // writeFileSync threw.
    rmSync(tempPath, { force: true });
  }
}

// Drop the recorded store so the next sync re-imports everything from local
// logs. Used by `reset` — the raw tool logs remain, so a re-parse rebuilds
// the same data. The Codex parser cache is intentionally kept (see reset.js).
export function clearStore() {
  try {
    unlinkSync(STORE_FILE);
  } catch (err) {
    // Already gone — same end state. Any other failure must surface: silently
    // keeping the file would make reset's re-sync import zero unchanged items.
    if (err?.code !== 'ENOENT') throw err;
  }
}

// Composite key: a project rename or hostname change alters the key, which
// naturally imports the re-keyed items as new rows (the stale ones get pruned
// by liveness on the same run).
export function bucketKey(b) {
  return `${b.source}|${b.model}|${b.project}|${b.hostname}|${b.bucketStart}`;
}

export function bucketHash(b) {
  return hash([
    b.inputTokens || 0,
    b.outputTokens || 0,
    b.cachedInputTokens || 0,
    b.reasoningOutputTokens || 0,
    b.totalTokens || 0,
  ]);
}

export function sessionKey(s) {
  return `${s.source}|${s.sessionHash}`;
}

export function sessionHash(s) {
  return hash([
    s.project,
    s.hostname,
    s.firstMessageAt,
    s.lastMessageAt,
    s.durationSeconds,
    s.activeSeconds,
    s.messageCount,
    s.userMessageCount,
    (s.userPromptHours || []).join(','),
  ]);
}

/**
 * Merge freshly parsed buckets/sessions into the store.
 * Mutates `store`. Returns counts of new/updated items so sync can report
 * what changed without sending anything over a network.
 */
export function mergeIntoStore(store, buckets = [], sessions = []) {
  let newBuckets = 0;
  let updatedBuckets = 0;
  let newSessions = 0;
  let updatedSessions = 0;

  for (const b of buckets) {
    const key = bucketKey(b);
    const h = bucketHash(b);
    const existing = store.buckets[key];
    if (!existing) {
      newBuckets++;
    } else if (existing.hash === h) {
      continue;
    } else {
      updatedBuckets++;
    }
    store.buckets[key] = { hash: h, data: b };
  }

  for (const s of sessions) {
    const key = sessionKey(s);
    const h = sessionHash(s);
    const existing = store.sessions[key];
    if (!existing) {
      newSessions++;
    } else if (existing.hash === h) {
      continue;
    } else {
      updatedSessions++;
    }
    store.sessions[key] = { hash: h, data: s };
  }

  return { newBuckets, updatedBuckets, newSessions, updatedSessions };
}

// Drop store entries the parsers no longer emit (e.g. the user deleted old
// tool logs) so usage.json can't grow forever. We must NOT prune by age: an
// old bucket's hash never changes, so keeping it is exactly what preserves
// history once the raw log is gone. `liveKeys` is the set of keys present in
// the current parse; anything not in it is dead.
//
// `okSources` (optional) scopes pruning to sources whose parser succeeded
// this run. A throwing parser emits no items, so without this guard its keys
// would look "dead" and get evicted — turning one transient failure into a
// full re-import of that tool's history on the next sync.
export function pruneStore(store, liveBucketKeys, liveSessionKeys, okSources) {
  const prunable = (key) =>
    !okSources || okSources.has(key.slice(0, key.indexOf('|')));
  for (const key of Object.keys(store.buckets)) {
    if (prunable(key) && !liveBucketKeys.has(key)) delete store.buckets[key];
  }
  for (const key of Object.keys(store.sessions)) {
    if (prunable(key) && !liveSessionKeys.has(key)) delete store.sessions[key];
  }
  return store;
}

function hash(parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}
