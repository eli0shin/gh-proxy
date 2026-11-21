import { randomUUID } from 'node:crypto';

import { GitHubClient, GitHubError } from './github.ts';
import type { Entry, Store } from './store.ts';

// A resource class is one kind of cached GitHub read, such as a pull request's
// status. Its fetch receives every key that needs a refresh, including keys
// other processes asked for, so it can batch them into as few requests as the
// API allows.
export type ResourceClass<P> = {
  readonly name: string;
  keyOf(params: P): string;
  fetch(batch: readonly FetchItem<P>[], context: FetchContext): Promise<Map<string, FetchOutcome>>;
};

export type FetchItem<P> = {
  readonly key: string;
  readonly params: P;
  readonly previous: Entry | undefined;
};

export type FetchContext = {
  readonly client: GitHubClient;
  readonly store: Store;
  // Extends the lease while a long batch runs.
  readonly heartbeat: () => void;
};

export type FetchOutcome =
  | { readonly ok: true; readonly value: unknown; readonly etag?: string | null }
  | { readonly ok: false; readonly error: string };

export type ReadResult = {
  readonly key: string;
  readonly value: unknown;
  readonly fetchedAt: number | null;
  readonly stale: boolean;
  readonly error: string | null;
};

export type ReadOptions = {
  readonly maxAgeMs: number;
  // Callers stop waiting for another process's fetch after this long.
  readonly waitMs?: number;
};

const LEASE_TTL_MS = 45_000;
const INTEREST_WINDOW_MS = 10 * 60_000;
const ERROR_RETRY_MS = 15_000;
const WAIT_POLL_MS = 50;
const DEFAULT_WAIT_MS = 60_000;
const MAX_REFRESH_KEYS = 200;

export class Engine {
  readonly store: Store;
  private readonly clients = new Map<string, GitHubClient>();

  constructor(store: Store) {
    this.store = store;
  }

  client(host: string): GitHubClient {
    let client = this.clients.get(host);
    if (!client) {
      client = new GitHubClient(host, this.store);
      this.clients.set(host, client);
    }
    return client;
  }

  async scopedKey<P>(resource: ResourceClass<P>, host: string, params: P): Promise<string> {
    return `${await this.scope(resource, host)}|${resource.keyOf(params)}`;
  }

  async scope<P>(resource: ResourceClass<P>, host: string): Promise<string> {
    return `${resource.name}|${host}|${await this.client(host).fingerprint()}`;
  }

  // Returns one result per params, in order. A value younger than max age is
  // served from the cache. Otherwise one process takes the scope's lease and
  // refreshes every stale key that any process asked for recently, while the
  // other processes wait for it and read its results.
  async read<P>(resource: ResourceClass<P>, host: string, paramsList: readonly P[], options: ReadOptions): Promise<ReadResult[]> {
    const callStart = Date.now();
    const scope = await this.scope(resource, host);
    const keys = paramsList.map((params) => `${scope}|${resource.keyOf(params)}`);
    const paramsByKey = new Map(keys.map((key, index) => [key, paramsList[index] as P]));
    this.store.recordInterest(
      scope,
      [...paramsByKey].map(([key, params]) => ({ key, params, maxAgeMs: options.maxAgeMs })),
      callStart,
    );

    const deadline = callStart + (options.waitMs ?? DEFAULT_WAIT_MS);
    const leaseName = scope;
    const holder = randomUUID();
    let fetched = 0;

    for (;;) {
      const now = Date.now();
      const entries = this.store.getEntries([...paramsByKey.keys()]);
      const needed = [...paramsByKey.keys()].filter((key) => needsFetch(entries.get(key), options.maxAgeMs, callStart, now));
      const finish = () => {
        this.store.logRead({ operation: resource.name, keys: keys.length, fetched }, now);
        return keys.map((key) => result(key, entries.get(key), options.maxAgeMs, callStart, now));
      };
      if (needed.length === 0) return finish();

      // The wait limit bounds only waiting for another process's fetch.
      if (!this.store.tryAcquireLease(leaseName, holder, LEASE_TTL_MS, now)) {
        if (now >= deadline) return finish();
        while (this.store.leaseHeld(leaseName, Date.now()) && Date.now() < deadline) await Bun.sleep(WAIT_POLL_MS);
        continue;
      }

      try {
        const others = this.store
          .interestedRefreshes(scope, now - INTEREST_WINDOW_MS, now, ERROR_RETRY_MS, MAX_REFRESH_KEYS)
          .filter((interest) => !paramsByKey.has(interest.key));
        const targets = new Map<string, P>(needed.map((key) => [key, paramsByKey.get(key) as P]));
        for (const interest of others) {
          if (targets.size >= MAX_REFRESH_KEYS) break;
          targets.set(interest.key, interest.params as P);
        }
        fetched += await this.refresh(resource, host, targets, leaseName, holder);
      } finally {
        this.store.releaseLease(leaseName, holder);
      }
    }
  }

  private async refresh<P>(
    resource: ResourceClass<P>,
    host: string,
    targets: Map<string, P>,
    leaseName: string,
    holder: string,
  ): Promise<number> {
    const requestedAt = Date.now();
    const previous = this.store.getEntries([...targets.keys()]);
    const batch = [...targets].map(([key, params]) => ({ key, params, previous: previous.get(key) }));
    const client = this.client(host);
    let outcomes: Map<string, FetchOutcome>;
    try {
      outcomes = await resource.fetch(batch, {
        client,
        store: this.store,
        heartbeat: () => this.store.renewLease(leaseName, holder, LEASE_TTL_MS, Date.now()),
      });
    } catch (error) {
      const message = describeError(error);
      outcomes = new Map(batch.map((item) => [item.key, { ok: false, error: message }]));
    }
    this.store.db.transaction(() => {
      for (const item of batch) {
        const outcome = outcomes.get(item.key) ?? { ok: false, error: 'GitHub returned no result' };
        if (outcome.ok) this.store.writeSuccess(item.key, outcome.value, requestedAt, outcome.etag ?? null);
        else this.store.writeFailure(item.key, outcome.error, requestedAt);
      }
    })();
    return batch.length;
  }
}

// A key needs a fetch when its value is older than max age, unless a fetch
// that started after this call already ran (and failed), or the last fetch
// failed so recently that retrying would only add load.
function needsFetch(entry: Entry | undefined, maxAgeMs: number, callStart: number, now: number): boolean {
  if (!entry) return true;
  if (isFresh(entry, maxAgeMs, callStart, now)) return false;
  if (entry.attemptedAt >= callStart) return false;
  if (entry.error !== null && now - entry.attemptedAt < ERROR_RETRY_MS) return false;
  return true;
}

// A value fetched by a request sent after this call started is always fresh,
// which is what max age 0 asks for.
function isFresh(entry: Entry, maxAgeMs: number, callStart: number, now: number): boolean {
  if (entry.fetchedAt <= 0) return false;
  return entry.fetchedAt >= callStart || now - entry.fetchedAt <= maxAgeMs;
}

function result(key: string, entry: Entry | undefined, maxAgeMs: number, callStart: number, now: number): ReadResult {
  if (!entry) return { key, value: null, fetchedAt: null, stale: true, error: 'no result' };
  const fresh = isFresh(entry, maxAgeMs, callStart, now);
  return {
    key,
    value: entry.value,
    fetchedAt: entry.fetchedAt > 0 ? entry.fetchedAt : null,
    stale: !fresh,
    error: entry.error,
  };
}

export function describeError(error: unknown): string {
  if (error instanceof GitHubError) return error.message;
  if (error instanceof Error) return error.name === 'TimeoutError' ? 'GitHub request timed out' : error.message;
  return String(error);
}
