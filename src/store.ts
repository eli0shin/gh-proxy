import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// One cached value per resource key. `fetchedAt` is the time the request that
// produced `value` was sent, so a value is never fresher than its request.
export type Entry = {
  readonly key: string;
  readonly value: unknown;
  readonly fetchedAt: number;
  readonly attemptedAt: number;
  readonly etag: string | null;
  readonly error: string | null;
};

export type Interest = {
  readonly key: string;
  readonly params: unknown;
  readonly maxAgeMs: number;
};

export type HttpLog = {
  readonly host: string;
  readonly resource: string;
  readonly operation: string;
  readonly items: number;
  readonly status: number;
  readonly cost: number | null;
  readonly remaining: number | null;
  readonly durationMs: number;
};

export type ReadLog = {
  readonly operation: string;
  readonly keys: number;
  readonly fetched: number;
};

const SCHEMA_VERSION = 1;
const WAL_SWITCH_WAIT_MS = 10_000;
const LOG_RETENTION_MS = 7 * 24 * 60 * 60_000;
const ENTRY_RETENTION_MS = 7 * 24 * 60 * 60_000;
const INTEREST_RETENTION_MS = 24 * 60 * 60_000;

export function defaultDatabasePath(): string {
  if (process.env.GHP_DB) return process.env.GHP_DB;
  const cache = process.env.XDG_CACHE_HOME?.startsWith('/')
    ? process.env.XDG_CACHE_HOME
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches')
      : join(homedir(), '.cache');
  return join(cache, 'ghp', 'cache.db');
}

export class Store {
  readonly db: Database;
  readonly consumer: string;

  constructor(path = defaultDatabasePath(), consumer = 'unknown') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    // The cache holds private pull request data.
    chmodSync(path, 0o600);
    this.consumer = consumer;
    this.db.exec('PRAGMA busy_timeout = 10000');
    this.enableWal();
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  // Switching to WAL takes an exclusive lock, and SQLite does not wait on its
  // busy handler while another process is switching the same new file. WAL
  // persists in the file, so only the first processes ever need this.
  private enableWal(): void {
    const deadline = Date.now() + WAL_SWITCH_WAIT_MS;
    for (;;) {
      try {
        const mode = this.db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode;
        if (mode !== 'wal') this.db.exec('PRAGMA journal_mode = WAL');
        return;
      } catch (error) {
        if (!(error instanceof Error && /database is locked/.test(error.message)) || Date.now() > deadline) throw error;
        Bun.sleepSync(10 + Math.random() * 40);
      }
    }
  }

  private migrate(): void {
    const version = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
    if (version >= SCHEMA_VERSION) return;
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          key TEXT PRIMARY KEY,
          value TEXT,
          fetched_at INTEGER NOT NULL DEFAULT 0,
          attempted_at INTEGER NOT NULL DEFAULT 0,
          etag TEXT,
          error TEXT
        );
        CREATE TABLE IF NOT EXISTS interest (
          key TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          params TEXT NOT NULL,
          max_age_ms INTEGER NOT NULL,
          requested_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS interest_scope ON interest (scope, requested_at);
        CREATE TABLE IF NOT EXISTS leases (
          name TEXT PRIMARY KEY,
          holder TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rate_gate (
          name TEXT PRIMARY KEY,
          blocked_until INTEGER NOT NULL,
          reason TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS http_log (
          at INTEGER NOT NULL,
          consumer TEXT NOT NULL,
          host TEXT NOT NULL,
          resource TEXT NOT NULL,
          operation TEXT NOT NULL,
          items INTEGER NOT NULL,
          status INTEGER NOT NULL,
          cost INTEGER,
          remaining INTEGER,
          duration_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS http_log_at ON http_log (at);
        CREATE TABLE IF NOT EXISTS read_log (
          at INTEGER NOT NULL,
          consumer TEXT NOT NULL,
          operation TEXT NOT NULL,
          keys INTEGER NOT NULL,
          fetched INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS read_log_at ON read_log (at);
      `);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    })();
  }

  getEntries(keys: readonly string[]): Map<string, Entry> {
    const result = new Map<string, Entry>();
    const statement = this.db.query<
      { key: string; value: string | null; fetched_at: number; attempted_at: number; etag: string | null; error: string | null },
      [string]
    >('SELECT key, value, fetched_at, attempted_at, etag, error FROM entries WHERE key = ?');
    for (const key of keys) {
      const row = statement.get(key);
      if (!row) continue;
      result.set(key, {
        key,
        value: row.value === null ? null : JSON.parse(row.value),
        fetchedAt: row.fetched_at,
        attemptedAt: row.attempted_at,
        etag: row.etag,
        error: row.error,
      });
    }
    return result;
  }

  // A successful fetch replaces the value. A failed fetch records the error
  // and keeps the last good value, so readers can still serve stale data.
  writeSuccess(key: string, value: unknown, requestedAt: number, etag: string | null = null): void {
    this.db
      .query(
        `INSERT INTO entries (key, value, fetched_at, attempted_at, etag, error) VALUES (?1, ?2, ?3, ?3, ?4, NULL)
         ON CONFLICT(key) DO UPDATE SET value = ?2, fetched_at = ?3, attempted_at = ?3, etag = ?4, error = NULL`,
      )
      .run(key, JSON.stringify(value), requestedAt, etag);
  }

  writeFailure(key: string, error: string, requestedAt: number): void {
    this.db
      .query(
        `INSERT INTO entries (key, value, fetched_at, attempted_at, error) VALUES (?1, NULL, 0, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET attempted_at = ?2, error = ?3`,
      )
      .run(key, requestedAt, error);
  }

  invalidate(keyPrefix: string): number {
    return this.db
      .query("UPDATE entries SET fetched_at = 0 WHERE key LIKE ?1 ESCAPE '\\'")
      .run(`${keyPrefix.replace(/[\\%_]/g, (character) => `\\${character}`)}%`).changes;
  }

  recordInterest(scope: string, items: readonly Interest[], now: number): void {
    const statement = this.db.query(
      `INSERT INTO interest (key, scope, params, max_age_ms, requested_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(key) DO UPDATE SET params = ?3, max_age_ms = ?4, requested_at = ?5`,
    );
    this.db.transaction(() => {
      for (const item of items) statement.run(item.key, scope, JSON.stringify(item.params), item.maxAgeMs, now);
    })();
  }

  // Keys other processes asked for recently whose values are at least half
  // their requested max age old. One refresh then serves every process.
  interestedRefreshes(scope: string, since: number, now: number, errorRetryMs: number, limit: number): Interest[] {
    return this.db
      .query<{ key: string; params: string; max_age_ms: number }, [string, number, number, number, number]>(
        `SELECT i.key, i.params, i.max_age_ms FROM interest i
         LEFT JOIN entries e ON e.key = i.key
         WHERE i.scope = ?1 AND i.requested_at >= ?2
           AND (e.key IS NULL OR e.fetched_at <= ?3 - i.max_age_ms / 2)
           AND (e.key IS NULL OR e.error IS NULL OR e.attempted_at < ?3 - ?4)
         ORDER BY i.requested_at DESC
         LIMIT ?5`,
      )
      .all(scope, since, now, errorRetryMs, limit)
      .map((row) => ({ key: row.key, params: JSON.parse(row.params), maxAgeMs: row.max_age_ms }));
  }

  tryAcquireLease(name: string, holder: string, ttlMs: number, now: number): boolean {
    const result = this.db
      .query(
        `INSERT INTO leases (name, holder, expires_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(name) DO UPDATE SET holder = ?2, expires_at = ?3 WHERE leases.expires_at < ?4`,
      )
      .run(name, holder, now + ttlMs, now);
    return result.changes > 0;
  }

  renewLease(name: string, holder: string, ttlMs: number, now: number): void {
    this.db.query('UPDATE leases SET expires_at = ?3 WHERE name = ?1 AND holder = ?2').run(name, holder, now + ttlMs);
  }

  releaseLease(name: string, holder: string): void {
    this.db.query('DELETE FROM leases WHERE name = ?1 AND holder = ?2').run(name, holder);
  }

  leaseHeld(name: string, now: number): boolean {
    return (
      this.db.query<{ held: number }, [string, number]>('SELECT 1 AS held FROM leases WHERE name = ?1 AND expires_at >= ?2').get(
        name,
        now,
      ) !== null
    );
  }

  gate(name: string, now: number): { blockedUntil: number; reason: string } | undefined {
    const row = this.db
      .query<{ blocked_until: number; reason: string }, [string, number]>(
        'SELECT blocked_until, reason FROM rate_gate WHERE name = ?1 AND blocked_until > ?2',
      )
      .get(name, now);
    return row ? { blockedUntil: row.blocked_until, reason: row.reason } : undefined;
  }

  closeGate(name: string, blockedUntil: number, reason: string): void {
    this.db
      .query(
        `INSERT INTO rate_gate (name, blocked_until, reason) VALUES (?1, ?2, ?3)
         ON CONFLICT(name) DO UPDATE SET blocked_until = MAX(blocked_until, ?2), reason = ?3`,
      )
      .run(name, blockedUntil, reason);
  }

  logHttp(log: HttpLog, now: number): void {
    this.db
      .query(
        `INSERT INTO http_log (at, consumer, host, resource, operation, items, status, cost, remaining, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(now, this.consumer, log.host, log.resource, log.operation, log.items, log.status, log.cost, log.remaining, log.durationMs);
  }

  logRead(log: ReadLog, now: number): void {
    this.db
      .query('INSERT INTO read_log (at, consumer, operation, keys, fetched) VALUES (?, ?, ?, ?, ?)')
      .run(now, this.consumer, log.operation, log.keys, log.fetched);
  }

  prune(now: number): void {
    this.db.query('DELETE FROM http_log WHERE at < ?').run(now - LOG_RETENTION_MS);
    this.db.query('DELETE FROM read_log WHERE at < ?').run(now - LOG_RETENTION_MS);
    this.db.query('DELETE FROM entries WHERE attempted_at < ?').run(now - ENTRY_RETENTION_MS);
    this.db.query('DELETE FROM interest WHERE requested_at < ?').run(now - INTEREST_RETENTION_MS);
    this.db.query('DELETE FROM leases WHERE expires_at < ?').run(now);
    this.db.query('DELETE FROM rate_gate WHERE blocked_until < ?').run(now);
  }

  close(): void {
    this.db.close();
  }
}
