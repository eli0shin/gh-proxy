import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { pullRequest, startFakeGitHub, type FakeGitHub } from './fake-github.ts';

const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
let fake: FakeGitHub;

beforeEach(() => {
  fake = startFakeGitHub();
  for (const number of [1, 2, 3]) fake.prs.set(String(number), pullRequest(number));
});

afterEach(() => fake.stop());

async function ghp(...args: string[]): Promise<{ code: number; json: any; stderr: string }> {
  const subprocess = Bun.spawn(['bun', cli, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...fake.env(), GH_TOKEN: '', GITHUB_TOKEN: '' },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { code, json: stdout.trim() ? JSON.parse(stdout) : null, stderr };
}

describe('pr status', () => {
  test('returns gh-shaped checks and REST-shaped activity', async () => {
    const { code, json } = await ghp('pr', 'status', 'acme/widgets#1');
    expect(code).toBe(0);
    const [result] = json;
    expect(result.error).toBeNull();
    expect(result.stale).toBe(false);
    expect(result.value.checks).toEqual([
      {
        name: 'test',
        state: 'SUCCESS',
        startedAt: '2026-11-02T00:00:00Z',
        completedAt: '2026-11-02T00:01:00Z',
        link: 'https://github.com/acme/widgets/actions/runs/1/job/2',
        bucket: 'pass',
        event: 'pull_request',
        workflow: 'CI',
        description: '',
      },
    ]);
    expect(result.value.issueComments).toEqual([
      { id: '100', createdAt: '2026-11-02T00:00:00Z', author: { login: 'renovate[bot]', type: 'Bot', isBot: true } },
    ]);
    // The pending comment is the author's own draft and is not shown.
    expect(result.value.reviewComments.map((comment: { id: string }) => comment.id)).toEqual(['300']);
  });

  test('serves a fresh cached value without a request', async () => {
    await ghp('pr', 'status', 'acme/widgets#1');
    const before = fake.requests.length;
    const { json } = await ghp('pr', 'status', 'https://github.com/acme/widgets/pull/1');
    expect(fake.requests.length).toBe(before);
    expect(json[0].value.number).toBe(1);
  });

  test('max age 0 refetches', async () => {
    await ghp('pr', 'status', 'acme/widgets#1');
    await ghp('pr', 'status', '--max-age', '0', 'acme/widgets#1');
    expect(fake.count('GhpPrStatus')).toBe(2);
  });

  test('fetches review comments only when review activity changed', async () => {
    await ghp('pr', 'status', 'acme/widgets#1');
    await ghp('pr', 'status', '--max-age', '0', 'acme/widgets#1');
    expect(fake.count('GhpPrReviewComments')).toBe(1);
    fake.prs.set('1', pullRequest(1, { reviewThreads: { totalCount: 1, nodes: [{ comments: { totalCount: 2 } }] } }));
    await ghp('pr', 'status', '--max-age', '0', 'acme/widgets#1');
    expect(fake.count('GhpPrReviewComments')).toBe(2);
  });

  test('batches several pull requests into one query', async () => {
    await ghp('pr', 'status', 'acme/widgets#1', 'acme/widgets#2', 'acme/widgets#3');
    const queries = fake.requests.filter((request) => request.operation === 'GhpPrStatus');
    expect(queries).toHaveLength(1);
    expect(queries[0]?.aliases).toBe(3);
  });

  test('reports a missing pull request per target', async () => {
    const { code, json } = await ghp('pr', 'status', 'acme/widgets#1', 'acme/widgets#404');
    expect(code).toBe(3);
    expect(json[0].value.number).toBe(1);
    expect(json[1].value).toBeNull();
    expect(json[1].error).toContain('not found');
  });
});

describe('sharing across processes', () => {
  test('concurrent processes asking for one pull request make one request', async () => {
    fake.delayMs = 300;
    const results = await Promise.all(Array.from({ length: 8 }, () => ghp('pr', 'status', 'acme/widgets#1')));
    expect(results.every((result) => result.json[0].value.number === 1)).toBe(true);
    expect(fake.count('GhpPrStatus')).toBe(1);
  });

  test("a refresh includes other processes' nearly stale pull requests", async () => {
    await ghp('pr', 'status', '--max-age', '2', 'acme/widgets#1');
    // PR 1 is now past half its max age, so the next fetch takes it along.
    await Bun.sleep(1100);
    await ghp('pr', 'status', '--max-age', '2', 'acme/widgets#2');
    const second = fake.requests.filter((request) => request.operation === 'GhpPrStatus')[1];
    expect(second?.aliases).toBe(2);
    const before = fake.requests.length;
    const { json } = await ghp('pr', 'status', '--max-age', '2', 'acme/widgets#1');
    expect(json[0].stale).toBe(false);
    expect(fake.requests.length).toBe(before);
  });
});

describe('rate limits', () => {
  test('a rate limit closes the shared gate and readers get stale data without requests', async () => {
    await ghp('pr', 'status', 'acme/widgets#1');
    fake.rateLimited = true;
    const limited = await ghp('pr', 'status', '--max-age', '0', 'acme/widgets#1');
    expect(limited.json[0].value.number).toBe(1);
    expect(limited.json[0].stale).toBe(true);
    expect(limited.json[0].error).toContain('rate limit');
    const requests = fake.requests.length;
    const gated = await ghp('pr', 'status', '--max-age', '0', 'acme/widgets#2');
    expect(fake.requests.length).toBe(requests);
    expect(gated.json[0].value).toBeNull();
    expect(gated.json[0].error).toContain('paused until');
  });
});

describe('runs', () => {
  test('maps runs to gh run list fields and revalidates with the ETag', async () => {
    const first = await ghp('runs', 'acme/widgets', 'abc');
    expect(first.json[0].value).toEqual([
      {
        attempt: 1,
        conclusion: '',
        createdAt: '2026-11-02T00:00:00Z',
        databaseId: 9,
        displayTitle: 'Fix',
        event: 'push',
        headBranch: 'main',
        headSha: 'abc',
        name: 'CI',
        number: 4,
        startedAt: '2026-11-02T00:00:00Z',
        status: 'in_progress',
        updatedAt: '2026-11-02T00:01:00Z',
        url: 'https://github.com/acme/widgets/actions/runs/9',
        workflowDatabaseId: 77,
        workflowName: 'CI workflow',
      },
    ]);
    const second = await ghp('runs', '--max-age', '0', 'acme/widgets', 'abc');
    expect(second.json[0].value).toEqual(first.json[0].value);
    expect(fake.count('rest-runs')).toBe(2);
    expect(fake.count('rest-workflows')).toBe(1);
  });
});

describe('search', () => {
  test('falls back to a query without Stacks on hosts that lack them', async () => {
    fake.noStacks = true;
    const first = await ghp('search', 'is:pr review-requested:@me');
    expect(first.json.error).toBeNull();
    expect(first.json.value.stacks).toBe(false);
    expect(first.json.value.nodes[0]).toMatchObject({ number: 1, reviewDecision: '', statusCheckRollup: [{ name: 'test' }] });
    expect(fake.count('GhpSearch')).toBe(2);
    // The host's missing Stacks are remembered.
    await ghp('search', '--max-age', '0', 'is:pr review-requested:@me');
    expect(fake.count('GhpSearch')).toBe(3);
  });
});

describe('wait', () => {
  test('--wait 0 still fetches when no other process holds the lease', async () => {
    const { json } = await ghp('pr', 'status', '--wait', '0', 'acme/widgets#1');
    expect(json[0].value.number).toBe(1);
  });
});

describe('invalidate', () => {
  test('makes the next read refetch', async () => {
    await ghp('pr', 'status', 'acme/widgets#1');
    await ghp('invalidate', 'acme/widgets#1');
    await ghp('pr', 'status', 'acme/widgets#1');
    expect(fake.count('GhpPrStatus')).toBe(2);
  });
});

describe('usage errors', () => {
  test('rejects a target that is not a pull request', async () => {
    const { code, stderr } = await ghp('pr', 'status', 'not-a-pr');
    expect(code).toBe(2);
    expect(stderr).toContain('Not a pull request URL');
  });
});
