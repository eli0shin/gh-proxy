import { aggregateChecks, CHECK_CONTEXT_FIELDS, type Check, type CheckContext } from '../checks.ts';
import type { FetchContext, FetchItem, FetchOutcome, ResourceClass } from '../engine.ts';
import { runBatched, runQuery, type AliasOutcome } from '../graphql.ts';
import { pullRequestUrl, repositoryKey, type PullRequestTarget } from '../targets.ts';
import { actor, type Actor, type RawActor } from './actors.ts';

export type PrStatus = {
  readonly id: string;
  readonly url: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly isDraft: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly headRepository: { readonly nameWithOwner: string } | null;
  readonly baseRefName: string;
  readonly author: Actor | null;
  readonly mergeable: string;
  readonly mergeCommit: { readonly oid: string } | null;
  readonly mergedAt: string | null;
  readonly reviewDecision: string | null;
  readonly reviewRequests: readonly ReviewRequest[];
  // `gh pr checks --json` entries for the head commit; empty when it has none.
  readonly checks: readonly Check[];
  readonly checksState: string | null;
  // The newest 100 of each, which always contains any activity since the last poll.
  readonly issueComments: readonly Activity[];
  readonly issueCommentsTotal: number;
  readonly reviews: readonly ReviewActivity[];
  readonly reviewsTotal: number;
  // Every submitted inline review comment.
  readonly reviewComments: readonly ReviewCommentActivity[];
  readonly reviewCommentsFetchedAt: number;
  readonly reviewSignature: string;
};

export type ReviewRequest =
  | { readonly type: 'User' | 'Bot' | 'Mannequin'; readonly login: string }
  | { readonly type: 'Team'; readonly name: string; readonly slug: string };

// `id` is the REST id (GraphQL fullDatabaseId), so it matches ids read from
// the REST API.
export type Activity = { readonly id: string; readonly createdAt: string | null; readonly author: Actor | null };
export type ReviewActivity = Activity & { readonly state: string };
export type ReviewCommentActivity = Activity & { readonly reviewId: string | null };

const REVIEW_COMMENTS_MAX_AGE_MS = 15 * 60_000;
const CHUNK_SIZE = 30;

const STATUS_FRAGMENT = `
fragment GhpPrStatus on PullRequest {
  id number url title state isDraft createdAt updatedAt
  headRefName headRefOid headRepository { nameWithOwner } baseRefName
  author { __typename login }
  mergeable mergeCommit { oid } mergedAt reviewDecision
  reviewRequests(first: 100) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { name slug } } }
  }
  commits(last: 1) {
    nodes { commit { oid statusCheckRollup { state contexts(first: 100) {
      pageInfo { hasNextPage endCursor }
      nodes { ${CHECK_CONTEXT_FIELDS} }
    } } } }
  }
  comments(last: 100) { totalCount nodes { fullDatabaseId createdAt author { __typename login } } }
  reviews(last: 100) { totalCount nodes { fullDatabaseId state submittedAt author { __typename login } } }
  reviewThreads(last: 100) { totalCount nodes { comments { totalCount } } }
}`;

const REVIEW_COMMENT_FIELDS = 'fullDatabaseId state createdAt author { __typename login } pullRequestReview { fullDatabaseId }';

const REVIEW_THREADS_FIELDS = `reviewThreads(first: 100, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { id comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${REVIEW_COMMENT_FIELDS} } } }
}`;

type Connection<T> = {
  readonly totalCount?: number;
  readonly pageInfo?: { readonly hasNextPage: boolean; readonly endCursor: string | null };
  readonly nodes: readonly (T | null)[];
};

type RawRollup = { readonly state: string; readonly contexts: Connection<CheckContext> } | null;

type RawStatus = {
  readonly id: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: PrStatus['state'];
  readonly isDraft: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly headRepository: { readonly nameWithOwner: string } | null;
  readonly baseRefName: string;
  readonly author: RawActor | null;
  readonly mergeable: string;
  readonly mergeCommit: { readonly oid: string } | null;
  readonly mergedAt: string | null;
  readonly reviewDecision: string | null;
  readonly reviewRequests: Connection<{ readonly requestedReviewer: (RawActor & { name?: string; slug?: string }) | null }>;
  readonly commits: Connection<{ readonly commit: { readonly oid: string; readonly statusCheckRollup: RawRollup } }>;
  readonly comments: Connection<{ readonly fullDatabaseId: string; readonly createdAt: string; readonly author: RawActor | null }>;
  readonly reviews: Connection<{
    readonly fullDatabaseId: string;
    readonly state: string;
    readonly submittedAt: string | null;
    readonly author: RawActor | null;
  }>;
  readonly reviewThreads: Connection<{ readonly comments: { readonly totalCount: number } }>;
};

type RawReviewComment = {
  readonly fullDatabaseId: string;
  readonly state: string;
  readonly createdAt: string;
  readonly author: RawActor | null;
  readonly pullRequestReview: { readonly fullDatabaseId: string } | null;
};

type RawThread = { readonly id: string; readonly comments: Connection<RawReviewComment> };

export const prStatus: ResourceClass<PullRequestTarget> = {
  name: 'pr-status',
  keyOf: (target) => `${repositoryKey(target)}#${target.number}`,
  async fetch(batch, context) {
    const outcomes = new Map<string, FetchOutcome>();
    const tier1 = await runBatched(
      context.client,
      'pr-status',
      batch.map((item) => repositorySelection(item.params, 'pullRequest(number: $number) { ...GhpPrStatus }')),
      { fragments: STATUS_FRAGMENT, chunkSize: CHUNK_SIZE, heartbeat: context.heartbeat },
    );

    const statuses: { item: FetchItem<PullRequestTarget>; raw: RawStatus }[] = [];
    batch.forEach((item, index) => {
      const raw = pullRequestFrom(tier1[index] as AliasOutcome);
      if (!raw.ok) outcomes.set(item.key, raw);
      else statuses.push({ item, raw: raw.data as RawStatus });
    });

    const now = Date.now();
    const needsReviewComments = statuses.filter(({ item, raw }) => {
      const previous = item.previous?.value as PrStatus | null | undefined;
      return (
        !previous ||
        previous.reviewSignature !== reviewSignature(raw) ||
        now - previous.reviewCommentsFetchedAt > REVIEW_COMMENTS_MAX_AGE_MS
      );
    });
    const reviewComments = await fetchReviewComments(
      needsReviewComments.map(({ item, raw }) => ({ key: item.key, target: item.params, prId: raw.id })),
      context,
    );

    for (const { item, raw } of statuses) {
      try {
        const contexts = await allCheckContexts(raw, context);
        const previous = item.previous?.value as PrStatus | null | undefined;
        const fetchedComments = reviewComments.get(item.key);
        if (fetchedComments && !fetchedComments.ok) {
          outcomes.set(item.key, fetchedComments);
          continue;
        }
        outcomes.set(item.key, {
          ok: true,
          value: toStatus(
            item.params,
            raw,
            contexts,
            fetchedComments?.ok ? fetchedComments.comments : (previous?.reviewComments ?? []),
            fetchedComments?.ok ? now : (previous?.reviewCommentsFetchedAt ?? now),
          ),
        });
      } catch (error) {
        outcomes.set(item.key, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return outcomes;
  },
};

export function repositorySelection(target: { owner: string; name: string; number?: number }, inner: string) {
  return {
    variables: {
      owner: ['String!', target.owner] as const,
      name: ['String!', target.name] as const,
      ...(target.number === undefined ? {} : { number: ['Int!', target.number] as const }),
    },
    field: `repository(owner: $owner, name: $name) { ${inner} }`,
  };
}

function pullRequestFrom(outcome: AliasOutcome): AliasOutcome {
  if (!outcome.ok) return outcome;
  const repository = outcome.data as { pullRequest?: unknown } | null;
  if (!repository) return { ok: false, error: 'not found: repository' };
  if (!repository.pullRequest) return { ok: false, error: 'not found: pull request' };
  return { ok: true, data: repository.pullRequest };
}

export function reviewSignature(raw: Pick<RawStatus, 'reviewThreads'>): string {
  const comments = raw.reviewThreads.nodes.reduce((sum, thread) => sum + (thread?.comments.totalCount ?? 0), 0);
  return `${raw.reviewThreads.totalCount ?? 0}:${comments}`;
}

async function allCheckContexts(raw: RawStatus, context: FetchContext): Promise<CheckContext[]> {
  const rollup = raw.commits.nodes[0]?.commit.statusCheckRollup;
  if (!rollup) return [];
  const contexts = rollup.contexts.nodes.filter((node): node is CheckContext => node !== null);
  let pageInfo = rollup.contexts.pageInfo;
  while (pageInfo?.hasNextPage) {
    const page = await runQuery<{ node: Pick<RawStatus, 'commits'> }>(
      context.client,
      'pr-checks-page',
      `query GhpPrChecksPage($id: ID!, $after: String) { node(id: $id) { ... on PullRequest {
        commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor } nodes { ${CHECK_CONTEXT_FIELDS} }
        } } } } }
      } } }`,
      { id: raw.id, after: pageInfo.endCursor },
    );
    const next = page.node.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
    if (!next) break;
    contexts.push(...next.nodes.filter((node): node is CheckContext => node !== null));
    pageInfo = next.pageInfo;
    context.heartbeat();
  }
  return contexts;
}

type ReviewCommentsOutcome =
  | { readonly ok: true; readonly comments: ReviewCommentActivity[] }
  | { readonly ok: false; readonly error: string };

async function fetchReviewComments(
  items: readonly { key: string; target: PullRequestTarget; prId: string }[],
  context: FetchContext,
): Promise<Map<string, ReviewCommentsOutcome>> {
  const results = new Map<string, ReviewCommentsOutcome>();
  if (items.length === 0) return results;
  const firstPages = await runBatched(
    context.client,
    'pr-review-comments',
    items.map((item) => ({
      ...repositorySelection(item.target, `pullRequest(number: $number) { ${REVIEW_THREADS_FIELDS} }`),
      variables: { ...repositorySelection(item.target, '').variables, after: ['String', null] as const },
    })),
    { chunkSize: 10, heartbeat: context.heartbeat },
  );
  for (const [index, item] of items.entries()) {
    const outcome = pullRequestFrom(firstPages[index] as AliasOutcome);
    if (!outcome.ok) {
      results.set(item.key, outcome);
      continue;
    }
    try {
      const threads: RawThread[] = [];
      let connection = (outcome.data as { reviewThreads: Connection<RawThread> }).reviewThreads;
      for (;;) {
        threads.push(...connection.nodes.filter((thread): thread is RawThread => thread !== null));
        if (!connection.pageInfo?.hasNextPage) break;
        const page = await runQuery<{ node: { reviewThreads: Connection<RawThread> } }>(
          context.client,
          'pr-review-threads-page',
          `query GhpReviewThreadsPage($id: ID!, $after: String) { node(id: $id) { ... on PullRequest { ${REVIEW_THREADS_FIELDS} } } }`,
          { id: item.prId, after: connection.pageInfo.endCursor },
        );
        connection = page.node.reviewThreads;
        context.heartbeat();
      }
      const comments: RawReviewComment[] = [];
      for (const thread of threads) {
        comments.push(...thread.comments.nodes.filter((comment): comment is RawReviewComment => comment !== null));
        let pageInfo = thread.comments.pageInfo;
        while (pageInfo?.hasNextPage) {
          const page = await runQuery<{ node: { comments: Connection<RawReviewComment> } }>(
            context.client,
            'pr-review-thread-comments-page',
            `query GhpThreadCommentsPage($id: ID!, $after: String) { node(id: $id) { ... on PullRequestReviewThread {
              comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${REVIEW_COMMENT_FIELDS} } }
            } } }`,
            { id: thread.id, after: pageInfo.endCursor },
          );
          comments.push(...page.node.comments.nodes.filter((comment): comment is RawReviewComment => comment !== null));
          pageInfo = page.node.comments.pageInfo;
          context.heartbeat();
        }
      }
      results.set(item.key, {
        ok: true,
        // A pending comment is visible only to its author until submitted.
        comments: comments
          .filter((comment) => comment.state !== 'PENDING')
          .map((comment) => ({
            id: comment.fullDatabaseId,
            createdAt: comment.createdAt,
            author: actor(comment.author),
            reviewId: comment.pullRequestReview?.fullDatabaseId ?? null,
          })),
      });
    } catch (error) {
      results.set(item.key, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

function toStatus(
  target: PullRequestTarget,
  raw: RawStatus,
  contexts: readonly CheckContext[],
  reviewComments: readonly ReviewCommentActivity[],
  reviewCommentsFetchedAt: number,
): PrStatus {
  const rollup = raw.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  return {
    id: raw.id,
    url: raw.url || pullRequestUrl(target),
    repo: repositoryFromUrl(raw.url) ?? `${target.owner}/${target.name}`,
    number: raw.number,
    title: raw.title,
    state: raw.state,
    isDraft: raw.isDraft,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    headRefName: raw.headRefName,
    headRefOid: raw.headRefOid,
    headRepository: raw.headRepository,
    baseRefName: raw.baseRefName,
    author: actor(raw.author),
    mergeable: raw.mergeable,
    mergeCommit: raw.mergeCommit,
    mergedAt: raw.mergedAt,
    reviewDecision: raw.reviewDecision,
    reviewRequests: raw.reviewRequests.nodes.flatMap((node): ReviewRequest[] => {
      const reviewer = node?.requestedReviewer;
      if (!reviewer) return [];
      if (reviewer.__typename === 'Team') return [{ type: 'Team', name: reviewer.name ?? '', slug: reviewer.slug ?? '' }];
      const normalized = actor(reviewer);
      return normalized ? [{ type: reviewer.__typename as 'User' | 'Bot' | 'Mannequin', login: normalized.login }] : [];
    }),
    checks: aggregateChecks(contexts),
    checksState: rollup?.state ?? null,
    issueComments: raw.comments.nodes.flatMap((node) =>
      node ? [{ id: node.fullDatabaseId, createdAt: node.createdAt, author: actor(node.author) }] : [],
    ),
    issueCommentsTotal: raw.comments.totalCount ?? 0,
    reviews: raw.reviews.nodes.flatMap((node) =>
      node ? [{ id: node.fullDatabaseId, state: node.state, createdAt: node.submittedAt, author: actor(node.author) }] : [],
    ),
    reviewsTotal: raw.reviews.totalCount ?? 0,
    reviewComments,
    reviewCommentsFetchedAt,
    reviewSignature: reviewSignature(raw),
  };
}

// The canonical owner/name, which follows renames and transfers.
export function repositoryFromUrl(url: string): string | undefined {
  const match = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url);
  return match?.[1];
}
