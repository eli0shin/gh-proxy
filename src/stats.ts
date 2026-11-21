import type { Store } from './store.ts';

export function stats(store: Store, since: number) {
  const http = store.db
    .query<
      { resource: string; operation: string; consumer: string; requests: number; items: number; cost: number; not_modified: number; errors: number },
      [number]
    >(
      `SELECT resource, operation, consumer, COUNT(*) AS requests, SUM(items) AS items,
              COALESCE(SUM(cost), 0) AS cost,
              SUM(CASE WHEN status = 304 THEN 1 ELSE 0 END) AS not_modified,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
       FROM http_log WHERE at >= ? GROUP BY resource, operation, consumer ORDER BY cost DESC, requests DESC`,
    )
    .all(since);
  const reads = store.db
    .query<{ operation: string; consumer: string; reads: number; keys: number; fetched: number }, [number]>(
      `SELECT operation, consumer, COUNT(*) AS reads, SUM(keys) AS keys, SUM(fetched) AS fetched
       FROM read_log WHERE at >= ? GROUP BY operation, consumer ORDER BY reads DESC`,
    )
    .all(since);
  const latest = store.db
    .query<{ resource: string; remaining: number }, []>(
      `SELECT resource, remaining FROM http_log WHERE remaining IS NOT NULL AND at = (
         SELECT MAX(at) FROM http_log AS inner_log WHERE inner_log.resource = http_log.resource AND remaining IS NOT NULL
       ) GROUP BY resource`,
    )
    .all();
  const gates = store.db
    .query<{ name: string; blocked_until: number; reason: string }, [number]>(
      'SELECT name, blocked_until, reason FROM rate_gate WHERE blocked_until > ?',
    )
    .all(Date.now())
    .map((gate) => ({ name: gate.name, blockedUntil: new Date(gate.blocked_until).toISOString(), reason: gate.reason }));
  const totals = {
    githubRequests: http.reduce((sum, row) => sum + row.requests, 0),
    graphqlPoints: http.filter((row) => row.resource === 'graphql').reduce((sum, row) => sum + row.cost, 0),
    restQuota: http.filter((row) => row.resource === 'core').reduce((sum, row) => sum + row.cost, 0),
    reads: reads.reduce((sum, row) => sum + row.reads, 0),
    keysRead: reads.reduce((sum, row) => sum + row.keys, 0),
    keysFetched: reads.reduce((sum, row) => sum + row.fetched, 0),
  };
  return { since: new Date(since).toISOString(), totals, remaining: latest, gates, http, reads };
}
