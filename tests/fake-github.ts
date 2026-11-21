import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type FakeRequest = { operation: string; aliases: number; variables: Record<string, unknown>; path: string };

export type FakeGitHub = {
  url: string;
  requests: FakeRequest[];
  // Replies with a rate limit error until cleared.
  rateLimited: boolean;
  // Rejects the Stack fields, like GitHub Enterprise Server.
  noStacks: boolean;
  delayMs: number;
  prs: Map<string, ReturnType<typeof pullRequest>>;
  runsEtag: string;
  stop(): void;
  env(): Record<string, string>;
  count(operation: string): number;
};

export function pullRequest(number: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `PR_${number}`,
    number,
    url: `https://github.com/acme/widgets/pull/${number}`,
    title: `PR ${number}`,
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z',
    headRefName: `branch-${number}`,
    headRefOid: `sha${number}`,
    headRepository: { nameWithOwner: 'acme/widgets' },
    baseRefName: 'main',
    author: { __typename: 'User', login: 'eli' },
    mergeable: 'MERGEABLE',
    mergeCommit: null,
    mergedAt: null,
    reviewDecision: null,
    reviewRequests: { nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            oid: `sha${number}`,
            statusCheckRollup: {
              state: 'SUCCESS',
              contexts: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    __typename: 'CheckRun',
                    name: 'test',
                    status: 'COMPLETED',
                    conclusion: 'SUCCESS',
                    startedAt: '2026-11-02T00:00:00Z',
                    completedAt: '2026-11-02T00:01:00Z',
                    detailsUrl: 'https://github.com/acme/widgets/actions/runs/1/job/2',
                    checkSuite: { workflowRun: { event: 'pull_request', workflow: { name: 'CI' } } },
                  },
                ],
              },
            },
          },
        },
      ],
    },
    comments: {
      totalCount: 1,
      nodes: [{ fullDatabaseId: '100', createdAt: '2026-11-02T00:00:00Z', author: { __typename: 'Bot', login: 'renovate' } }],
    },
    reviews: { totalCount: 0, nodes: [] },
    reviewThreads: { totalCount: 1, nodes: [{ comments: { totalCount: 1 } }] },
    ...overrides,
  };
}

const threads = {
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes: [
    {
      id: 'T1',
      comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            fullDatabaseId: '300',
            state: 'SUBMITTED',
            createdAt: '2026-11-02T00:00:00Z',
            author: { __typename: 'User', login: 'reviewer' },
            pullRequestReview: { fullDatabaseId: '200' },
          },
          {
            fullDatabaseId: '301',
            state: 'PENDING',
            createdAt: '2026-11-02T00:00:00Z',
            author: { __typename: 'User', login: 'eli' },
            pullRequestReview: { fullDatabaseId: '201' },
          },
        ],
      },
    },
  ],
};

export function startFakeGitHub(): FakeGitHub {
  const fake: FakeGitHub = {
    url: '',
    requests: [],
    rateLimited: false,
    noStacks: false,
    delayMs: 0,
    prs: new Map(),
    runsEtag: '"runs-1"',
    stop: () => server.stop(true),
    env: () => ({}),
    count: (operation) => fake.requests.filter((request) => request.operation === operation).length,
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (fake.delayMs > 0) await Bun.sleep(fake.delayMs);
      const rateHeaders = { 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) };
      if (fake.rateLimited) {
        fake.requests.push({ operation: 'rate-limited', aliases: 0, variables: {}, path: url.pathname });
        return Response.json(
          { message: 'API rate limit exceeded' },
          { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) } },
        );
      }
      if (url.pathname === '/graphql') {
        const body = (await request.json()) as { query: string; variables: Record<string, unknown> };
        const operation = /query (\w+)/.exec(body.query)?.[1] ?? 'unknown';
        const aliases = new Set(Object.keys(body.variables).map((name) => name.split('_')[0])).size;
        fake.requests.push({ operation, aliases, variables: body.variables, path: url.pathname });
        if (operation === 'GhpSearch') {
          if (fake.noStacks && body.query.includes('stack {')) {
            return Response.json({
              errors: [
                {
                  path: ['query GhpSearch', 'a0', 'nodes', '... on PullRequest', 'stack'],
                  extensions: { code: 'undefinedField' },
                  message: "Field 'stack' doesn't exist on type 'PullRequest'",
                },
              ],
            });
          }
          const node = pullRequest(1);
          return Response.json({
            data: {
              rateLimit: { cost: 1, remaining: 4000, resetAt: '2026-11-21T00:00:00Z' },
              a0: {
                nodes: [{ ...node, repository: { nameWithOwner: 'acme/widgets' }, labels: { nodes: [] }, additions: 1, deletions: 2, changedFiles: 3 }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }
        const data: Record<string, unknown> = { rateLimit: { cost: 1, remaining: 4000, resetAt: '2026-11-21T00:00:00Z' } };
        for (let index = 0; ; index += 1) {
          const number = body.variables[`a${index}_number`];
          if (number === undefined) break;
          const pr = fake.prs.get(String(number));
          if (operation === 'GhpPrReviewComments') data[`a${index}`] = { pullRequest: pr ? { reviewThreads: threads } : null };
          else data[`a${index}`] = { pullRequest: pr ?? null };
        }
        return Response.json({ data }, { headers: rateHeaders });
      }
      if (url.pathname.endsWith('/actions/runs')) {
        fake.requests.push({ operation: 'rest-runs', aliases: 1, variables: {}, path: url.pathname });
        if (request.headers.get('if-none-match') === fake.runsEtag) return new Response(null, { status: 304, headers: rateHeaders });
        return Response.json(
          {
            workflow_runs: [
              {
                id: 9,
                name: 'CI',
                display_title: 'Fix',
                run_attempt: 1,
                conclusion: null,
                status: 'in_progress',
                created_at: '2026-11-02T00:00:00Z',
                updated_at: '2026-11-02T00:01:00Z',
                run_started_at: '2026-11-02T00:00:00Z',
                event: 'push',
                head_branch: 'main',
                head_sha: 'abc',
                run_number: 4,
                html_url: 'https://github.com/acme/widgets/actions/runs/9',
                workflow_id: 77,
              },
            ],
          },
          { headers: { ...rateHeaders, etag: fake.runsEtag } },
        );
      }
      if (url.pathname.endsWith('/actions/workflows')) {
        fake.requests.push({ operation: 'rest-workflows', aliases: 1, variables: {}, path: url.pathname });
        return Response.json({ workflows: [{ id: 77, name: 'CI workflow' }] }, { headers: { ...rateHeaders, etag: '"wf"' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  fake.url = `http://localhost:${server.port}`;
  const db = join(mkdtempSync(join(tmpdir(), 'ghp-test-')), 'cache.db');
  fake.env = () => ({ GHP_API_URL: fake.url, GHP_TOKEN: 'test-token', GHP_DB: db });
  return fake;
}
