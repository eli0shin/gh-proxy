import { describe, expect, test } from 'bun:test';

import { aggregateChecks, rollupEntries, ZERO_TIME, type CheckContext } from '../src/checks.ts';
import { parseRemoteUrl } from '../src/local.ts';
import { actor } from '../src/resources/actors.ts';
import { parsePullRequestTarget, parseRepositoryTarget } from '../src/targets.ts';

const run = (overrides: Partial<CheckContext>): CheckContext => ({
  __typename: 'CheckRun',
  name: 'build',
  status: 'COMPLETED',
  conclusion: 'SUCCESS',
  startedAt: '2026-11-02T00:00:00Z',
  completedAt: '2026-11-02T00:05:00Z',
  detailsUrl: 'https://example.test/1',
  checkSuite: { workflowRun: { event: 'pull_request', workflow: { name: 'CI' } } },
  ...overrides,
});

describe('aggregateChecks (gh pr checks)', () => {
  test('keeps the newest run of each check name, workflow, and event', () => {
    const checks = aggregateChecks([
      run({ conclusion: 'FAILURE', startedAt: '2026-11-02T00:00:00Z' }),
      run({ conclusion: 'SUCCESS', startedAt: '2026-11-02T01:00:00Z' }),
      run({ checkSuite: { workflowRun: { event: 'push', workflow: { name: 'CI' } } } }),
    ]);
    expect(checks.map((check) => [check.state, check.event])).toEqual([
      ['SUCCESS', 'pull_request'],
      ['SUCCESS', 'push'],
    ]);
  });

  test("maps states to gh's buckets", () => {
    const states = ['SUCCESS', 'SKIPPED', 'NEUTRAL', 'FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED', 'STARTUP_FAILURE'];
    const buckets = states.map((conclusion, index) => aggregateChecks([run({ name: `c${index}`, conclusion })])[0]?.bucket);
    expect(buckets).toEqual(['pass', 'skipping', 'skipping', 'fail', 'fail', 'fail', 'cancel', 'pending']);
  });

  test('an unfinished check reports its status and Go zero times', () => {
    const [check] = aggregateChecks([run({ status: 'WAITING', conclusion: null, completedAt: null, startedAt: null })]);
    expect(check).toMatchObject({ state: 'WAITING', bucket: 'pending', completedAt: ZERO_TIME, startedAt: ZERO_TIME });
  });

  test('status contexts use their context, state, and target URL', () => {
    const [check] = aggregateChecks([
      { __typename: 'StatusContext', context: 'tide', state: 'PENDING', targetUrl: 'https://prow.test', createdAt: '2026-11-02T00:00:00Z', description: 'Not mergeable' },
    ]);
    expect(check).toEqual({
      name: 'tide',
      state: 'PENDING',
      startedAt: ZERO_TIME,
      completedAt: ZERO_TIME,
      link: 'https://prow.test',
      bucket: 'pending',
      event: '',
      workflow: '',
      description: 'Not mergeable',
    });
  });

  test('rollup entries match gh pr view --json statusCheckRollup', () => {
    expect(rollupEntries([run({}), { __typename: 'StatusContext', context: 'tide', state: 'SUCCESS', targetUrl: 'u', createdAt: 't' }])).toEqual([
      {
        __typename: 'CheckRun',
        completedAt: '2026-11-02T00:05:00Z',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://example.test/1',
        name: 'build',
        startedAt: '2026-11-02T00:00:00Z',
        status: 'COMPLETED',
        workflowName: 'CI',
      },
      { __typename: 'StatusContext', context: 'tide', state: 'SUCCESS', targetUrl: 'u', startedAt: 't' },
    ]);
  });
});

describe('actor', () => {
  test('restores the [bot] suffix REST uses', () => {
    expect(actor({ __typename: 'Bot', login: 'github-actions' })).toEqual({ login: 'github-actions[bot]', type: 'Bot', isBot: true });
    expect(actor({ __typename: 'User', login: 'eli' })).toEqual({ login: 'eli', type: 'User', isBot: false });
    expect(actor(null)).toBeNull();
  });
});

describe('targets', () => {
  test('parses pull request URLs and shorthand', () => {
    expect(parsePullRequestTarget('https://github.com/acme/widgets/pull/12/files')).toEqual({ host: 'github.com', owner: 'acme', name: 'widgets', number: 12 });
    expect(parsePullRequestTarget('ghe.corp/acme/widgets#3')).toEqual({ host: 'ghe.corp', owner: 'acme', name: 'widgets', number: 3 });
    expect(() => parsePullRequestTarget('acme/widgets')).toThrow();
  });

  test('parses repositories', () => {
    expect(parseRepositoryTarget('acme/widgets')).toEqual({ host: 'github.com', owner: 'acme', name: 'widgets' });
    expect(parseRepositoryTarget('https://ghe.corp/acme/widgets.git')).toEqual({ host: 'ghe.corp', owner: 'acme', name: 'widgets' });
  });

  test('parses git remote URLs', () => {
    expect(parseRemoteUrl('git@github.com:acme/widgets.git')).toEqual({ host: 'github.com', owner: 'acme', name: 'widgets' });
    expect(parseRemoteUrl('ssh://git@ssh.github.com:443/acme/widgets.git')).toEqual({ host: 'github.com', owner: 'acme', name: 'widgets' });
    expect(parseRemoteUrl('https://github.com/acme/widgets')).toEqual({ host: 'github.com', owner: 'acme', name: 'widgets' });
    expect(parseRemoteUrl('/local/path')).toBeUndefined();
  });
});
