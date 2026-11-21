import { createHash } from 'node:crypto';

import type { Store } from './store.ts';

export type ApiResource = 'graphql' | 'core';

export class GitHubError extends Error {
  readonly status: number;
  readonly rateLimited: boolean;

  constructor(message: string, status: number, rateLimited = false) {
    super(message);
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

export type GraphQLError = {
  readonly message: string;
  readonly type?: string;
  readonly path?: readonly (string | number)[];
};

export type GraphQLResponse = {
  readonly data: Record<string, unknown> | null;
  readonly errors: readonly GraphQLError[];
};

export type RestResponse = {
  readonly status: number;
  readonly etag: string | null;
  readonly link: string | null;
  readonly body: unknown;
};

const REQUEST_TIMEOUT_MS = 30_000;
const SECONDARY_LIMIT_BACKOFF_MS = 60_000;
// Leave headroom for the agents' own gh commands and interactive use.
const DEFAULT_RESERVE = 200;

export function gateName(host: string, resource: ApiResource): string {
  return `${host}|${resource}`;
}

export class GitHubClient {
  readonly host: string;
  private readonly store: Store;
  private token: string | undefined;

  constructor(host: string, store: Store) {
    this.host = host;
    this.store = store;
  }

  // Cache keys include the token's fingerprint: what a token can see differs
  // by account, and a stale entry must never leak across accounts.
  async fingerprint(): Promise<string> {
    return createHash('sha256').update(await this.resolveToken()).digest('hex').slice(0, 12);
  }

  private async resolveToken(): Promise<string> {
    if (this.token) return this.token;
    const fromEnv =
      process.env.GHP_TOKEN ||
      (this.host === 'github.com'
        ? process.env.GH_TOKEN || process.env.GITHUB_TOKEN
        : process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_ENTERPRISE_TOKEN);
    if (fromEnv) return (this.token = fromEnv);
    const subprocess = Bun.spawn(['gh', 'auth', 'token', '--hostname', this.host], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);
    const token = stdout.trim();
    if (code !== 0 || !token) {
      throw new GitHubError(`No GitHub token for ${this.host}: ${stderr.trim() || 'run gh auth login'}`, 401);
    }
    return (this.token = token);
  }

  private apiBase(): string {
    if (process.env.GHP_API_URL) return process.env.GHP_API_URL.replace(/\/$/, '');
    return this.host === 'github.com' ? 'https://api.github.com' : `https://${this.host}/api/v3`;
  }

  private graphqlUrl(): string {
    if (process.env.GHP_API_URL) return `${this.apiBase()}/graphql`;
    return this.host === 'github.com' ? 'https://api.github.com/graphql' : `https://${this.host}/api/graphql`;
  }

  // Throws a rate-limited GitHubError without a request while the shared gate
  // is closed, so a rate limit stops every process instead of each retrying.
  assertGateOpen(resource: ApiResource): void {
    const gate = this.store.gate(gateName(this.host, resource), Date.now());
    if (gate) {
      throw new GitHubError(
        `GitHub ${resource} requests paused until ${new Date(gate.blockedUntil).toISOString()}: ${gate.reason}`,
        429,
        true,
      );
    }
  }

  async graphql(operation: string, query: string, variables: Record<string, unknown>, items: number): Promise<GraphQLResponse> {
    this.assertGateOpen('graphql');
    const started = Date.now();
    const response = await fetch(this.graphqlUrl(), {
      method: 'POST',
      headers: await this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: { data?: Record<string, unknown> | null; errors?: GraphQLError[]; message?: string } = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 300) };
    }
    const errors = body.errors ?? [];
    const rateLimit = body.data?.rateLimit as { cost?: number; remaining?: number } | undefined;
    this.store.logHttp(
      {
        host: this.host,
        resource: 'graphql',
        operation,
        items,
        status: response.status,
        cost: rateLimit?.cost ?? null,
        remaining: rateLimit?.remaining ?? headerNumber(response, 'x-ratelimit-remaining'),
        durationMs: Date.now() - started,
      },
      Date.now(),
    );
    const graphqlRateLimited = errors.some((error) => error.type === 'RATE_LIMITED');
    this.updateGate('graphql', response, text, graphqlRateLimited);
    if (!response.ok || graphqlRateLimited) {
      throw new GitHubError(
        errors[0]?.message ?? body.message ?? `GitHub GraphQL returned HTTP ${response.status}`,
        response.status,
        graphqlRateLimited || isRateLimitResponse(response, text),
      );
    }
    return { data: body.data ?? null, errors };
  }

  async rest(operation: string, path: string, etag: string | null): Promise<RestResponse> {
    this.assertGateOpen('core');
    const started = Date.now();
    const extra: Record<string, string> = etag ? { 'If-None-Match': etag } : {};
    const response = await fetch(`${this.apiBase()}${path}`, {
      headers: await this.headers(extra),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    this.store.logHttp(
      {
        host: this.host,
        resource: 'core',
        operation,
        items: 1,
        status: response.status,
        // A 304 for an authorized conditional request costs no quota.
        cost: response.status === 304 ? 0 : 1,
        remaining: headerNumber(response, 'x-ratelimit-remaining'),
        durationMs: Date.now() - started,
      },
      Date.now(),
    );
    this.updateGate('core', response, text, false);
    if (response.status === 304) return { status: 304, etag, link: response.headers.get('link'), body: null };
    if (!response.ok) {
      let message = `GitHub returned HTTP ${response.status} for ${path}`;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        // Keep the status message.
      }
      throw new GitHubError(message, response.status, isRateLimitResponse(response, text));
    }
    return { status: response.status, etag: response.headers.get('etag'), link: response.headers.get('link'), body: JSON.parse(text) };
  }

  private async headers(extra: Record<string, string>): Promise<Record<string, string>> {
    return {
      Authorization: `bearer ${await this.resolveToken()}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ghp',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  private updateGate(resource: ApiResource, response: Response, text: string, graphqlRateLimited: boolean): void {
    const now = Date.now();
    const remaining = headerNumber(response, 'x-ratelimit-remaining');
    const reset = headerNumber(response, 'x-ratelimit-reset');
    const retryAfter = headerNumber(response, 'retry-after');
    const name = gateName(this.host, resource);
    if (retryAfter !== null && (response.status === 403 || response.status === 429)) {
      this.store.closeGate(name, now + retryAfter * 1000, 'GitHub asked to retry later');
      return;
    }
    if (graphqlRateLimited || isRateLimitResponse(response, text)) {
      const until = remaining === 0 && reset !== null ? reset * 1000 + 1000 : now + SECONDARY_LIMIT_BACKOFF_MS;
      this.store.closeGate(name, until, remaining === 0 ? 'rate limit exhausted' : 'secondary rate limit');
      return;
    }
    const reserve = Number(process.env.GHP_RESERVE ?? DEFAULT_RESERVE);
    if (remaining !== null && reset !== null && remaining < reserve) {
      this.store.closeGate(name, reset * 1000 + 1000, `only ${remaining} requests left; keeping ${reserve} in reserve`);
    }
  }
}

function headerNumber(response: Response, name: string): number | null {
  const value = response.headers.get(name);
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isRateLimitResponse(response: Response, text: string): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(text);
}
