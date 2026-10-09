import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ScrobbleLog } from './src/types';

const file = process.env.ACTIVITY_DB_PATH || path.resolve('data/activity.sqlite');
mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
export const activityDb = new DatabaseSync(file);
activityDb.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    timestamp INTEGER NOT NULL, level TEXT NOT NULL, category TEXT NOT NULL, operation TEXT, jobId TEXT,
    requestId TEXT, outcome TEXT, record TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS activity_time ON activity(timestamp);
  CREATE INDEX IF NOT EXISTS activity_level ON activity(level, seq);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
const retentionDays = Math.max(1, Number(process.env.ACTIVITY_RETENTION_DAYS) || 90);
let lastPruned = 0;
export function recordActivity(level: ScrobbleLog['level'], message: string, extra: Partial<ScrobbleLog> = {}): ScrobbleLog {
  // Explicit allowlist: request bodies, headers, credentials and upstream raw payloads never enter the journal.
  const record: ScrobbleLog = { id: crypto.randomUUID(), timestamp: Date.now(), level, message: message.slice(0, 1500), category: extra.category || 'job' };
  for (const key of ['track', 'artist', 'album', 'count', 'total', 'operation', 'jobId', 'requestId', 'outcome', 'httpStatus', 'errorCode', 'durationMs', 'retryAfterSeconds', 'accepted', 'ignored', 'attempted', 'scrobbleTimestamp'] as const) {
    if (extra[key] !== undefined) Object.assign(record, { [key]: extra[key] });
  }
  const result = activityDb.prepare('INSERT INTO activity(id,timestamp,level,category,operation,jobId,requestId,outcome,record) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(record.id, record.timestamp, level, record.category!, record.operation || null, record.jobId || null, record.requestId || null, record.outcome || null, JSON.stringify(record));
  record.seq = Number(result.lastInsertRowid);
  if (Date.now() - lastPruned > 3600000) {
    activityDb.prepare('DELETE FROM activity WHERE timestamp < ?').run(Date.now() - retentionDays * 86400000);
    lastPruned = Date.now();
  }
  return record;
}
export function readActivity(options: { before?: number; after?: number; level?: string; search?: string; limit?: number } = {}) {
  const conditions = ['1=1']; const values: (string | number)[] = [];
  if (options.before) { conditions.push('seq < ?'); values.push(options.before); }
  if (options.after) { conditions.push('seq > ?'); values.push(options.after); }
  if (options.level && options.level !== 'all') { conditions.push('level = ?'); values.push(options.level); }
  if (options.search) { conditions.push("record LIKE ? ESCAPE '\\'"); values.push(`%${options.search.replace(/[\\%_]/g, '\\$&')}%`); }
  const limit = Math.min(500, Math.max(1, options.limit || 100));
  const rows = activityDb.prepare(`SELECT seq,record FROM activity WHERE ${conditions.join(' AND ')} ORDER BY seq DESC LIMIT ?`).all(...values, limit + 1);
  const hasMore = rows.length > limit;
  const logs = rows.slice(0, limit).map(row => ({ ...JSON.parse(String(row.record)), seq: Number(row.seq) } as ScrobbleLog)).reverse();
  return { logs, hasMore, nextBefore: logs[0]?.seq || null };
}
export function activitySummary() {
  const row = activityDb.prepare(`SELECT COUNT(*) totalEvents,
    COALESCE(SUM(CASE WHEN outcome='accepted' THEN json_extract(record,'$.accepted') ELSE 0 END),0) accepted,
    COALESCE(SUM(CASE WHEN category='api' THEN json_extract(record,'$.ignored') ELSE 0 END),0) ignored,
    SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END) failedRequests,
    SUM(CASE WHEN outcome='rate_limited' THEN 1 ELSE 0 END) rateLimitHits,
    SUM(CASE WHEN outcome='uncertain' THEN 1 ELSE 0 END) uncertainRequests,
    SUM(CASE WHEN outcome='attempt' THEN 1 ELSE 0 END) requests,
    SUM(CASE WHEN outcome='simulated' THEN 1 ELSE 0 END) simulated,
    COALESCE(SUM(CASE WHEN outcome='played' THEN 1 ELSE 0 END),0) played,
    MIN(timestamp) oldestAt, MAX(timestamp) latestAt FROM activity`).get();
  return { ...row, retentionDays, storage: 'sqlite', healthy: true };
}
export function *exportActivity() {
  for (const row of activityDb.prepare('SELECT seq,record FROM activity ORDER BY seq').iterate()) {
    yield { ...JSON.parse(String(row.record)), seq: Number(row.seq) } as ScrobbleLog;
  }
}
export function saveCheckpoint(job: unknown) {
  activityDb.prepare("INSERT INTO settings(key,value) VALUES('job',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(job));
}
export function loadCheckpoint(): unknown {
  const row = activityDb.prepare("SELECT value FROM settings WHERE key='job'").get();
  return row ? JSON.parse(String(row.value)) : null;
}
