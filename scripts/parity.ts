// Compares ghp's reads with the gh commands they replace, on live pull
// requests: `bun run parity <pr-url>...` (default: a sample of open cli/cli PRs).
// Exits non-zero on any difference.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
const env = { ...process.env, GHP_DB: join(mkdtempSync(join(tmpdir(), 'ghp-parity-')), 'cache.db'), GHP_CONSUMER: 'parity' };

async function run(command: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const subprocess = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe', env });
  const [stdout, stderr, code] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { code, stdout, stderr };
}

async function json<T>(command: string[]): Promise<T> {
  const result = await run(command);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`${command.join(' ')} failed (${result.code}): ${result.stderr.trim() || result.stdout.slice(0, 200)}`);
  }
}

async function restIds(path: string): Promise<{ id: string; login: string }[]> {
  const result = await run(['gh', 'api', '--paginate', path, '--jq', '.[] | {id: (.id|tostring), login: .user.login}']);
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

let failures = 0;
function compare(label: string, expected: unknown, actual: unknown): void {
  const left = JSON.stringify(expected);
  const right = JSON.stringify(actual);
  if (left === right) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures += 1;
  console.log(`  DIFF  ${label}\n    gh:  ${left.slice(0, 600)}\n    ghp: ${right.slice(0, 600)}`);
}

const sortStrings = (values: string[]) => [...values].sort();

let urls = process.argv.slice(2);
if (urls.length === 0) {
  const sample = await json<{ url: string }[]>(['gh', 'pr', 'list', '-R', 'cli/cli', '--state', 'open', '-L', '6', '--json', 'url']);
  urls = sample.map((pr) => pr.url);
}

const statuses = await json<{ target: string; value: any; error: string | null }[]>(['bun', cli, 'pr', 'status', ...urls]);

for (const status of statuses) {
  const url = status.target;
  console.log(url);
  if (!status.value) {
    failures += 1;
    console.log(`  DIFF  ghp returned no value: ${status.error}`);
    continue;
  }
  const value = status.value;
  const [, repo, number] = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url) as unknown as [string, string, string];

  const view = await json<any>([
    'gh', 'pr', 'view', url, '--json',
    'headRefOid,headRefName,headRepository,state,author,mergeable,mergeCommit,mergedAt,isDraft,reviewDecision,baseRefName,number',
  ]);
  compare('pr view fields', {
    headRefOid: view.headRefOid,
    headRefName: view.headRefName,
    headRepository: view.headRepository?.nameWithOwner ?? null,
    state: view.state,
    mergeable: view.mergeable,
    mergeCommit: view.mergeCommit?.oid ?? null,
    mergedAt: view.mergedAt ?? null,
    isDraft: view.isDraft,
    reviewDecision: view.reviewDecision || null,
    baseRefName: view.baseRefName,
    number: view.number,
  }, {
    headRefOid: value.headRefOid,
    headRefName: value.headRefName,
    headRepository: value.headRepository?.nameWithOwner ?? null,
    state: value.state,
    mergeable: value.mergeable,
    mergeCommit: value.mergeCommit?.oid ?? null,
    mergedAt: value.mergedAt ?? null,
    isDraft: value.isDraft,
    reviewDecision: value.reviewDecision,
    baseRefName: value.baseRefName,
    number: value.number,
  });
  // gh prints a bot PR author as app/<name>; only compare people.
  if (!view.author?.is_bot) compare('author login', view.author?.login, value.author?.login);

  const checksResult = await run(['gh', 'pr', 'checks', url, '--json', 'name,state,bucket,workflow,link,completedAt,startedAt,event,description']);
  const ghChecks: any[] = checksResult.stdout.trim() ? JSON.parse(checksResult.stdout) : [];
  const checkKey = (check: any) =>
    JSON.stringify([check.workflow, check.name, check.state, check.bucket, check.completedAt, check.startedAt, check.link, check.event, check.description]);
  compare(`checks (${ghChecks.length})`, sortStrings(ghChecks.map(checkKey)), sortStrings(value.checks.map(checkKey)));

  const issueComments = await restIds(`repos/${repo}/issues/${number}/comments?per_page=100`);
  const reviews = await restIds(`repos/${repo}/pulls/${number}/reviews?per_page=100`);
  const reviewComments = await restIds(`repos/${repo}/pulls/${number}/comments?per_page=100`);
  const pairs = (items: { id: string; author: { login: string } | null }[]) =>
    items.map((item) => `${item.id}:${item.author?.login ?? ''}`);
  // REST names Copilot's inline comments `Copilot`; GraphQL names its bot.
  const restLogin = (login: string) => (login === 'Copilot' ? 'copilot-pull-request-reviewer[bot]' : login);
  const restPairs = (items: { id: string; login: string }[]) => items.map((item) => `${item.id}:${restLogin(item.login)}`);
  compare(`issue comments (${issueComments.length})`, sortStrings(restPairs(issueComments.slice(-100))), sortStrings(pairs(value.issueComments)));
  compare(`reviews (${reviews.length})`, sortStrings(restPairs(reviews.slice(-100))), sortStrings(pairs(value.reviews)));
  compare(`review comments (${reviewComments.length})`, sortStrings(restPairs(reviewComments)), sortStrings(pairs(value.reviewComments)));

  const runFields = 'databaseId,attempt,name,workflowName,status,conclusion,url,event,createdAt,updatedAt,headSha,number';
  const ghRuns = await json<any[]>(['gh', 'run', 'list', '--commit', value.headRefOid, '-R', repo, '-L', '100', '--json', runFields]);
  const ghpRuns = await json<{ value: any[] | null }[]>(['bun', cli, 'runs', repo, value.headRefOid]);
  const runKey = (entry: any) => JSON.stringify(runFields.split(',').map((field) => entry[field]));
  compare(`runs (${ghRuns.length})`, sortStrings(ghRuns.map(runKey)), sortStrings((ghpRuns[0]?.value ?? []).map(runKey)));
}

const stats = await json<{ totals: unknown }>(['bun', cli, 'stats', '--since', '60']);
console.log('\nghp usage for this run:', JSON.stringify(stats.totals));
console.log(failures === 0 ? '\nparity: all equal' : `\nparity: ${failures} difference(s)`);
process.exit(failures === 0 ? 0 : 1);
