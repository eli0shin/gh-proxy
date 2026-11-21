import type { FetchOutcome, ResourceClass } from '../engine.ts';
import { runBatched, type AliasOutcome } from '../graphql.ts';
import { repositoryKey } from '../targets.ts';
import { repositorySelection } from './pr-status.ts';

type RepositoryParams = { readonly owner: string; readonly name: string };
type BranchParams = RepositoryParams & { readonly branch: string };

export type Viewer = { readonly login: string };

export const viewer: ResourceClass<Record<string, never>> = {
  name: 'viewer',
  keyOf: () => 'viewer',
  async fetch(batch, context) {
    const [outcome] = await runBatched(context.client, 'viewer', [{ variables: {}, field: 'viewer { login }' }], {
      chunkSize: 1,
    });
    return new Map(batch.map((item) => [item.key, toOutcome(outcome as AliasOutcome, (data) => data)]));
  },
};

export type RepositoryInfo = {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly defaultBranch: string | null;
};

export const repository: ResourceClass<RepositoryParams> = {
  name: 'repo',
  keyOf: repositoryKey,
  async fetch(batch, context) {
    const outcomes = await runBatched(
      context.client,
      'repo',
      batch.map((item) => repositorySelection(item.params, 'nameWithOwner url defaultBranchRef { name }')),
      { chunkSize: 50, heartbeat: context.heartbeat },
    );
    return new Map(
      batch.map((item, index) => [
        item.key,
        toOutcome(outcomes[index] as AliasOutcome, (data) => {
          const repo = data as { nameWithOwner: string; url: string; defaultBranchRef: { name: string } | null } | null;
          if (!repo) throw new Error('not found: repository');
          return { nameWithOwner: repo.nameWithOwner, url: repo.url, defaultBranch: repo.defaultBranchRef?.name ?? null };
        }),
      ]),
    );
  },
};

// `sha` is null when the branch does not exist on GitHub.
export type BranchTip = { readonly branch: string; readonly sha: string | null };

export const branchTip: ResourceClass<BranchParams> = {
  name: 'branch-tip',
  keyOf: (params) => `${repositoryKey(params)}@${params.branch}`,
  async fetch(batch, context) {
    const outcomes = await runBatched(
      context.client,
      'branch-tip',
      batch.map((item) => ({
        variables: { ...repositorySelection(item.params, '').variables, ref: ['String!', `refs/heads/${item.params.branch}`] as const },
        field: 'repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { target { oid } } }',
      })),
      { chunkSize: 50, heartbeat: context.heartbeat },
    );
    return new Map(
      batch.map((item, index) => [
        item.key,
        toOutcome(outcomes[index] as AliasOutcome, (data) => {
          const repo = data as { ref: { target: { oid: string } | null } | null } | null;
          if (!repo) throw new Error('not found: repository');
          return { branch: item.params.branch, sha: repo.ref?.target?.oid ?? null };
        }),
      ]),
    );
  },
};

export type FoundPullRequest = {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly headRefName: string;
  readonly headRepository: { readonly nameWithOwner: string } | null;
};

// `pullRequest` is gh pr view <branch>'s choice: an open PR for the branch,
// preferring one whose head is in the repository itself, else the newest.
export type BranchPullRequests = {
  readonly pullRequest: FoundPullRequest | null;
  readonly candidates: readonly FoundPullRequest[];
};

export const branchPullRequests: ResourceClass<BranchParams> = {
  name: 'pr-find',
  keyOf: (params) => `${repositoryKey(params)}@${params.branch}`,
  async fetch(batch, context) {
    const outcomes = await runBatched(
      context.client,
      'pr-find',
      batch.map((item) => ({
        variables: { ...repositorySelection(item.params, '').variables, branch: ['String!', item.params.branch] as const },
        field: `repository(owner: $owner, name: $name) {
          nameWithOwner
          pullRequests(headRefName: $branch, first: 20, orderBy: { field: CREATED_AT, direction: DESC }) {
            nodes { number url state headRefName headRepository { nameWithOwner } }
          }
        }`,
      })),
      { chunkSize: 50, heartbeat: context.heartbeat },
    );
    return new Map(
      batch.map((item, index) => [
        item.key,
        toOutcome(outcomes[index] as AliasOutcome, (data) => {
          const repo = data as { nameWithOwner: string; pullRequests: { nodes: (FoundPullRequest | null)[] } } | null;
          if (!repo) throw new Error('not found: repository');
          const candidates = repo.pullRequests.nodes.filter((node): node is FoundPullRequest => node !== null);
          const own = (pr: FoundPullRequest) => pr.headRepository?.nameWithOwner.toLowerCase() === repo.nameWithOwner.toLowerCase();
          const open = candidates.filter((pr) => pr.state === 'OPEN');
          const pullRequest = open.find(own) ?? open[0] ?? candidates.find(own) ?? candidates[0] ?? null;
          return { pullRequest, candidates };
        }),
      ]),
    );
  },
};

function toOutcome(outcome: AliasOutcome, map: (data: unknown) => unknown): FetchOutcome {
  if (!outcome.ok) return outcome;
  try {
    return { ok: true, value: map(outcome.data) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
