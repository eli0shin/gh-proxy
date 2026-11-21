import { CHECK_CONTEXT_FIELDS, rollupEntries, type CheckContext } from '../checks.ts';
import type { FetchOutcome, ResourceClass } from '../engine.ts';
import { describeError } from '../engine.ts';
import { remainingNodes, runBatched, type AliasOutcome, type Connection } from '../graphql.ts';
import { repositoryKey, type PullRequestTarget } from '../targets.ts';
import { repositorySelection } from './pr-status.ts';

type SearchParams = { readonly query: string; readonly size: number; readonly after: string | null };

// A search page. Each node holds the search fields Review asked for before,
// plus the fields it read with one `gh pr view` per row, in gh's shapes.
export type SearchPage = {
  readonly nodes: readonly Record<string, unknown>[];
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
  readonly stacks: boolean;
};

const REVIEW_FIELDS = 'id author { login } authorAssociation body submittedAt state commit { oid }';

const searchNodeFields = (withStacks: boolean) => `
  ... on PullRequest {
    number title author { login } isDraft state createdAt updatedAt url
    repository { nameWithOwner }
    labels(first: 100) { nodes { name } }
    comments { totalCount }
    additions deletions changedFiles reviewDecision
    reviews(last: 100) { nodes { ${REVIEW_FIELDS} } }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { ${CHECK_CONTEXT_FIELDS} } } } } } }${
      withStacks
        ? `
    stack { number size entries(first: 100) { nodes { pullRequest { url headRefName } } } }
    stackEntry { position }`
        : ''
    }
  }`;

// GitHub Enterprise Server does not have native Stacks yet.
const MISSING_STACK_FIELDS = /Field 'stack(Entry)?' doesn't exist on type 'PullRequest'/;

export const search: ResourceClass<SearchParams> = {
  name: 'search',
  keyOf: (params) => JSON.stringify([params.query, params.size, params.after]),
  async fetch(batch, context) {
    const capabilityKey = `capability|${context.client.host}|no-stacks`;
    const knownWithoutStacks = context.store.getEntries([capabilityKey]).has(capabilityKey);
    const run = (withStacks: boolean) =>
      runBatched(
        context.client,
        'search',
        batch.map((item) => ({
          variables: {
            query: ['String!', item.params.query] as const,
            size: ['Int!', item.params.size] as const,
            after: ['String', item.params.after] as const,
          },
          field: `search(query: $query, type: ISSUE_ADVANCED, first: $size, after: $after) {
            nodes { ${searchNodeFields(withStacks)} }
            pageInfo { hasNextPage endCursor }
          }`,
        })),
        { chunkSize: 4, heartbeat: context.heartbeat },
      );
    let withStacks = !knownWithoutStacks;
    let outcomes = await run(withStacks);
    if (withStacks && outcomes.some((outcome) => !outcome.ok && MISSING_STACK_FIELDS.test(outcome.error))) {
      context.store.writeSuccess(capabilityKey, true, Date.now());
      withStacks = false;
      outcomes = await run(false);
    }
    return new Map(
      batch.map((item, index): [string, FetchOutcome] => {
        const outcome = outcomes[index] as AliasOutcome;
        if (!outcome.ok) return [item.key, outcome];
        const page = outcome.data as { nodes: (Record<string, unknown> | null)[]; pageInfo: SearchPage['pageInfo'] };
        return [
          item.key,
          {
            ok: true,
            value: {
              nodes: page.nodes.flatMap((node) => (node && 'number' in node ? [searchNode(node)] : [])),
              pageInfo: page.pageInfo,
              stacks: withStacks,
            } satisfies SearchPage,
          },
        ];
      }),
    );
  },
};

function searchNode(node: Record<string, unknown>): Record<string, unknown> {
  const { commits, reviews, reviewDecision, ...rest } = node as {
    commits: Connection<{ commit: { statusCheckRollup: { contexts: Connection<CheckContext> } | null } }>;
    reviews: Connection<Record<string, unknown>>;
    reviewDecision: string | null;
  } & Record<string, unknown>;
  return {
    ...rest,
    reviewDecision: reviewDecision ?? '',
    reviews: reviews.nodes.filter((review) => review !== null).map(ghReview),
    statusCheckRollup: rollupEntries(contextsOf(commits)),
  };
}

function contextsOf(commits: Connection<{ commit: { statusCheckRollup: { contexts: Connection<CheckContext> } | null } }>) {
  return (commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).filter(
    (context): context is CheckContext => context !== null,
  );
}

const ghost = { login: 'ghost' };

function ghReview(review: Record<string, unknown>): Record<string, unknown> {
  return { ...review, author: review.author ?? ghost, submittedAt: review.submittedAt ?? null };
}

// Everything Review's Pull Request Details modal shows, in the shapes of
// `gh pr view --json <fields>` plus the review threads.
export type PullRequestDetails = {
  readonly metadata: Record<string, unknown>;
  readonly reviews: readonly Record<string, unknown>[];
  readonly statusCheckRollup: readonly Record<string, unknown>[];
  readonly comments: readonly Record<string, unknown>[];
  readonly reviewThreads: readonly Record<string, unknown>[];
};

const COMMENT_FIELDS = 'id author { login } authorAssociation body createdAt url';
const THREAD_COMMENT_FIELDS =
  'databaseId author { login } createdAt body path diffHunk line startLine originalLine originalStartLine outdated replyTo { databaseId }';
const THREAD_FIELDS = `id isResolved diffSide startDiffSide comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_COMMENT_FIELDS} } }`;

const DETAILS_FIELDS = `
  id number title body author { login } state isDraft url createdAt updatedAt baseRefName headRefName
  additions deletions changedFiles reviewDecision
  labels(first: 100) { nodes { id name description color } }
  reviewRequests(first: 100) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { name slug } } }
  }
  reviews(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${REVIEW_FIELDS} } }
  comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
    pageInfo { hasNextPage endCursor } nodes { ${CHECK_CONTEXT_FIELDS} }
  } } } } }
  reviewThreads(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_FIELDS} } }`;

type RawThread = Record<string, unknown> & { id: string; comments: Connection<Record<string, unknown>> };

export const pullRequestDetails: ResourceClass<PullRequestTarget> = {
  name: 'pr-details',
  keyOf: (target) => `${repositoryKey(target)}#${target.number}`,
  async fetch(batch, context) {
    const outcomes = await runBatched(
      context.client,
      'pr-details',
      batch.map((item) => repositorySelection(item.params, `pullRequest(number: $number) { ${DETAILS_FIELDS} }`)),
      { chunkSize: 5, heartbeat: context.heartbeat },
    );
    const results = new Map<string, FetchOutcome>();
    for (const [index, item] of batch.entries()) {
      const outcome = outcomes[index] as AliasOutcome;
      if (!outcome.ok) {
        results.set(item.key, outcome);
        continue;
      }
      const pr = (outcome.data as { pullRequest: Record<string, unknown> | null } | null)?.pullRequest;
      if (!pr) {
        results.set(item.key, { ok: false, error: 'not found: pull request' });
        continue;
      }
      try {
        results.set(item.key, { ok: true, value: await completeDetails(pr, context) });
      } catch (error) {
        results.set(item.key, { ok: false, error: describeError(error) });
      }
    }
    return results;
  },
};

async function completeDetails(
  pr: Record<string, unknown>,
  context: Parameters<ResourceClass<unknown>['fetch']>[1],
): Promise<PullRequestDetails> {
  const id = pr.id as string;
  const { client, heartbeat } = context;
  const reviews = await remainingNodes<Record<string, unknown>>(
    client,
    'pr-details-reviews',
    { id, typeName: 'PullRequest', connection: 'reviews', fields: REVIEW_FIELDS },
    pr.reviews as Connection<Record<string, unknown>>,
    heartbeat,
  );
  const comments = await remainingNodes<Record<string, unknown>>(
    client,
    'pr-details-comments',
    { id, typeName: 'PullRequest', connection: 'comments', fields: COMMENT_FIELDS },
    pr.comments as Connection<Record<string, unknown>>,
    heartbeat,
  );
  const threads = await remainingNodes<RawThread>(
    client,
    'pr-details-threads',
    { id, typeName: 'PullRequest', connection: 'reviewThreads', fields: THREAD_FIELDS },
    pr.reviewThreads as Connection<RawThread>,
    heartbeat,
  );
  const reviewThreads = [];
  for (const thread of threads) {
    const threadComments = await remainingNodes<Record<string, unknown>>(
      client,
      'pr-details-thread-comments',
      { id: thread.id, typeName: 'PullRequestReviewThread', connection: 'comments', fields: THREAD_COMMENT_FIELDS },
      thread.comments,
      heartbeat,
    );
    reviewThreads.push({ ...thread, comments: threadComments });
  }

  const commits = pr.commits as Connection<{ commit: { statusCheckRollup: { contexts: Connection<CheckContext> } | null } }>;
  const firstContexts = commits.nodes[0]?.commit.statusCheckRollup?.contexts;
  const contexts = firstContexts
    ? await remainingContexts(id, firstContexts, context)
    : [];

  const { reviews: _reviews, comments: _comments, reviewThreads: _threads, commits: _commits, ...metadata } = pr;
  return {
    metadata: {
      ...metadata,
      author: metadata.author ?? ghost,
      reviewDecision: metadata.reviewDecision ?? '',
      labels: (metadata.labels as Connection<Record<string, unknown>>).nodes.filter(Boolean),
      reviewRequests: (
        metadata.reviewRequests as Connection<{ requestedReviewer: Record<string, unknown> | null }>
      ).nodes.flatMap((node) => (node?.requestedReviewer ? [node.requestedReviewer] : [])),
    },
    reviews: reviews.map(ghReview),
    statusCheckRollup: rollupEntries(contexts),
    comments: comments.map((comment) => ({ ...comment, author: comment.author ?? ghost })),
    reviewThreads,
  };
}

async function remainingContexts(
  prId: string,
  first: Connection<CheckContext>,
  context: Parameters<ResourceClass<unknown>['fetch']>[1],
): Promise<CheckContext[]> {
  const contexts = first.nodes.filter((node): node is CheckContext => node !== null);
  let pageInfo = first.pageInfo;
  while (pageInfo?.hasNextPage) {
    const response = await context.client.graphql(
      'pr-details-checks',
      `query GhpDetailsChecks($id: ID!, $after: String) { node(id: $id) { ... on PullRequest {
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor } nodes { ${CHECK_CONTEXT_FIELDS} }
        } } } } }
      } } }`,
      { id: prId, after: pageInfo.endCursor },
      1,
    );
    const node = response.data?.node as
      | { commits: Connection<{ commit: { statusCheckRollup: { contexts: Connection<CheckContext> } | null } }> }
      | undefined;
    const page = node?.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
    if (!page) break;
    contexts.push(...page.nodes.filter((item): item is CheckContext => item !== null));
    pageInfo = page.pageInfo;
    context.heartbeat();
  }
  return contexts;
}
