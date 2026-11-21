#!/usr/bin/env bun
import { Command, InvalidArgumentError, Option } from 'commander';
import { resolve } from 'node:path';

import { Engine, type ReadResult, type ResourceClass } from './engine.ts';
import { localBranch, localRepository } from './local.ts';
import { prStatus } from './resources/pr-status.ts';
import { pullRequestDetails, search } from './resources/review.ts';
import { workflowRuns } from './resources/runs.ts';
import { branchPullRequests, branchTip, repository, viewer } from './resources/simple.ts';
import { Store } from './store.ts';
import { stats } from './stats.ts';
import { parsePullRequestTarget, parseRepositoryTarget, repositoryKey, UsageError, type RepositoryTarget } from './targets.ts';
import { version } from '../package.json';

// Exit status when at least one requested resource has no value at all.
const EXIT_MISSING = 3;
const EXIT_USAGE = 2;

type CommonOptions = { maxAge?: number; wait?: number; consumer?: string };

const seconds = (value: string): number => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new InvalidArgumentError('expected a number of seconds');
  return number;
};

function withCommon(command: Command, defaultMaxAge: number): Command {
  return command
    .addOption(new Option('--max-age <seconds>', 'serve cached data younger than this').argParser(seconds).default(defaultMaxAge))
    .addOption(new Option('--wait <seconds>', "how long to wait for another process's fetch").argParser(seconds).default(60))
    .option('--consumer <name>', 'name recorded in the request log (default: $GHP_CONSUMER)');
}

function openEngine(options: CommonOptions): Engine {
  const store = new Store(undefined, options.consumer ?? process.env.GHP_CONSUMER ?? 'cli');
  // Pruning is cheap; doing it on a small share of runs keeps the file small.
  if (Math.random() < 0.02) store.prune(Date.now());
  return new Engine(store);
}

type Output = { target?: string } & Omit<ReadResult, 'key'>;

function output(results: Output[], single: boolean): void {
  process.stdout.write(`${JSON.stringify(single ? results[0] : results)}\n`);
  if (results.some((result) => result.value === null)) process.exitCode = EXIT_MISSING;
}

function toOutput(target: string | undefined, result: ReadResult): Output {
  const { key: _key, ...rest } = result;
  return target === undefined ? rest : { target, ...rest };
}

// Reads targets that may span hosts, one engine read per host.
async function readByHost<P>(
  engine: Engine,
  resource: ResourceClass<P>,
  targets: readonly { label: string; host: string; params: P }[],
  options: CommonOptions,
): Promise<Output[]> {
  const outputs = new Array<Output>(targets.length);
  const hosts = new Map<string, number[]>();
  targets.forEach((target, index) => hosts.set(target.host, [...(hosts.get(target.host) ?? []), index]));
  for (const [host, indexes] of hosts) {
    const results = await engine.read(
      resource,
      host,
      indexes.map((index) => (targets[index] as { params: P }).params),
      { maxAgeMs: (options.maxAge ?? 60) * 1000, waitMs: (options.wait ?? 60) * 1000 },
    );
    indexes.forEach((index, position) => {
      outputs[index] = toOutput((targets[index] as { label: string }).label, results[position] as ReadResult);
    });
  }
  return outputs;
}

async function repositoryFrom(value: string | undefined, directory: string | undefined, host: string | undefined): Promise<RepositoryTarget> {
  if (value) return parseRepositoryTarget(value, host);
  return localRepository(resolve(directory ?? process.cwd()));
}

const program = new Command()
  .name('ghp')
  .description(
    'A shared, cached, batched GitHub reader. Every read is served from a cache shared by all processes when it is younger than --max-age; otherwise one process fetches, batching every stale key that any process asked for, while the others wait for its result.',
  )
  .version(version)
  .showHelpAfterError();

const pr = program.command('pr').description('pull request reads');

withCommon(
  pr
    .command('status')
    .description('state, head, mergeability, checks (as gh pr checks), reviews, and comment activity')
    .argument('<targets...>', 'pull request URLs or owner/repo#number'),
  60,
).action(async (targets: string[], options: CommonOptions) => {
  const engine = openEngine(options);
  const parsed = targets.map((target) => {
    const params = parsePullRequestTarget(target);
    return { label: target, host: params.host, params };
  });
  output(await readByHost(engine, prStatus, parsed, options), false);
});

withCommon(
  pr
    .command('find')
    .description("the pull request for a branch, as gh pr view <branch> picks it")
    .argument('[repo]', 'owner/repo (default: the repository in --dir)')
    .argument('[branches...]', 'branch names (default: the current branch in --dir)')
    .option('--dir <path>', 'git checkout to read the repository and branch from')
    .option('--host <host>', 'GitHub host for owner/repo', 'github.com'),
  60,
).action(async (repo: string | undefined, branches: string[], options: CommonOptions & { dir?: string; host: string }) => {
  const engine = openEngine(options);
  const target = await repositoryFrom(repo, options.dir, options.host);
  const names = branches.length > 0 ? branches : [await localBranch(resolve(options.dir ?? process.cwd()))];
  const parsed = names.map((branch) => ({ label: branch, host: target.host, params: { ...target, branch } }));
  output(await readByHost(engine, branchPullRequests, parsed, options), false);
});

withCommon(
  pr
    .command('details')
    .description("everything Review's details modal shows, in gh pr view shapes, plus review threads")
    .argument('<target>', 'pull request URL or owner/repo#number'),
  15,
).action(async (target: string, options: CommonOptions) => {
  const engine = openEngine(options);
  const params = parsePullRequestTarget(target);
  output(await readByHost(engine, pullRequestDetails, [{ label: target, host: params.host, params }], options), true);
});

withCommon(
  program
    .command('search')
    .description('a pull request search page with each row\'s size, review decision, reviews, and checks')
    .argument('<query>', 'GitHub search query')
    .option('--host <host>', 'GitHub host', 'github.com')
    .option('--size <n>', 'page size (1-100)', (value) => {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1 || number > 100) throw new InvalidArgumentError('expected 1-100');
      return number;
    }, 25)
    .option('--after <cursor>', 'cursor of the previous page'),
  60,
).action(async (query: string, options: CommonOptions & { host: string; size: number; after?: string }) => {
  const engine = openEngine(options);
  const params = { query, size: options.size, after: options.after ?? null };
  output(await readByHost(engine, search, [{ label: query, host: options.host, params }], options), true);
});

withCommon(
  program
    .command('branch-tip')
    .description("a branch's head commit on GitHub")
    .argument('<repo>', 'owner/repo')
    .argument('<branches...>', 'branch names')
    .option('--host <host>', 'GitHub host for owner/repo', 'github.com'),
  60,
).action(async (repo: string, branches: string[], options: CommonOptions & { host: string }) => {
  const engine = openEngine(options);
  const target = parseRepositoryTarget(repo, options.host);
  output(await readByHost(engine, branchTip, branches.map((branch) => ({ label: branch, host: target.host, params: { ...target, branch } })), options), false);
});

withCommon(
  program
    .command('runs')
    .description('workflow runs for a commit, as gh run list --commit prints them')
    .argument('<repo>', 'owner/repo')
    .argument('<shas...>', 'commit SHAs')
    .option('--host <host>', 'GitHub host for owner/repo', 'github.com'),
  60,
).action(async (repo: string, shas: string[], options: CommonOptions & { host: string }) => {
  const engine = openEngine(options);
  const target = parseRepositoryTarget(repo, options.host);
  output(await readByHost(engine, workflowRuns, shas.map((sha) => ({ label: sha, host: target.host, params: { ...target, sha } })), options), false);
});

withCommon(
  program
    .command('repo')
    .description('canonical name, URL, and default branch')
    .argument('[repo]', 'owner/repo (default: the repository in --dir)')
    .option('--dir <path>', 'git checkout to read the repository from (default: the current directory)')
    .option('--host <host>', 'GitHub host for owner/repo', 'github.com'),
  24 * 60 * 60,
).action(async (repo: string | undefined, options: CommonOptions & { dir?: string; host: string }) => {
  const engine = openEngine(options);
  const target = await repositoryFrom(repo, options.dir, options.host);
  const label = repo ?? `${target.owner}/${target.name}`;
  const [result] = await readByHost(engine, repository, [{ label, host: target.host, params: target }], options);
  output([{ ...(result as Output), ...(result?.value ? { value: { host: target.host, ...(result.value as object) } } : {}) }], true);
});

withCommon(
  program.command('whoami').description('the login of the authenticated account').option('--host <host>', 'GitHub host', 'github.com'),
  24 * 60 * 60,
).action(async (options: CommonOptions & { host: string }) => {
  const engine = openEngine(options);
  output(await readByHost(engine, viewer, [{ label: options.host, host: options.host, params: {} }], options), true);
});

program
  .command('invalidate')
  .description('mark cached reads of pull requests stale, e.g. after a mutation')
  .argument('<targets...>', 'pull request URLs or owner/repo#number')
  .option('--consumer <name>', 'name recorded in the request log')
  .action(async (targets: string[], options: CommonOptions) => {
    const engine = openEngine(options);
    let changed = 0;
    for (const target of targets) {
      const parsed = parsePullRequestTarget(target);
      for (const resource of [prStatus, pullRequestDetails] as ResourceClass<typeof parsed>[]) {
        const key = await engine.scopedKey(resource, parsed.host, parsed);
        changed += engine.store.invalidate(key);
      }
      const searchScope = await engine.scope(search, parsed.host);
      changed += engine.store.invalidate(`${searchScope}|`);
      const findScope = await engine.scope(branchPullRequests, parsed.host);
      changed += engine.store.invalidate(`${findScope}|${repositoryKey(parsed)}@`);
    }
    process.stdout.write(`${JSON.stringify({ invalidated: changed })}\n`);
  });

program
  .command('stats')
  .description('GitHub requests and cache reads, by operation and consumer')
  .option('--since <minutes>', 'window to summarize', (value) => seconds(value), 60)
  .action((options: { since: number }) => {
    const store = new Store(undefined, 'stats');
    process.stdout.write(`${JSON.stringify(stats(store, Date.now() - options.since * 60_000), null, 2)}\n`);
  });

try {
  await program.parseAsync();
} catch (error) {
  process.stderr.write(`ghp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof UsageError ? EXIT_USAGE : 1;
}
