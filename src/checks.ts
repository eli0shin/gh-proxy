// Check contexts from a commit's statusCheckRollup, reshaped exactly as gh
// prints them, so consumers that compare check snapshots across polls see the
// same strings they saw from gh.

export const ZERO_TIME = '0001-01-01T00:00:00Z';

export const CHECK_CONTEXT_FIELDS = `
  __typename
  ... on CheckRun {
    name status conclusion startedAt completedAt detailsUrl
    checkSuite { workflowRun { event workflow { name } } }
  }
  ... on StatusContext { context state targetUrl createdAt description }`;

export type CheckContext = {
  readonly __typename: string;
  readonly name?: string | null;
  readonly status?: string | null;
  readonly conclusion?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly detailsUrl?: string | null;
  readonly checkSuite?: { readonly workflowRun?: { readonly event?: string | null; readonly workflow?: { readonly name?: string | null } | null } | null } | null;
  readonly context?: string | null;
  readonly state?: string | null;
  readonly targetUrl?: string | null;
  readonly createdAt?: string | null;
  readonly description?: string | null;
};

// `gh pr checks --json` output.
export type Check = {
  readonly name: string;
  readonly state: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly link: string;
  readonly bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
  readonly event: string;
  readonly workflow: string;
  readonly description: string;
};

// gh reads every time into a Go time.Time, so a missing time prints as the
// zero time. StatusContext has no startedAt in gh's query.
function goTime(value: string | null | undefined): string {
  return value || ZERO_TIME;
}

function startedAtMs(context: CheckContext): number {
  const value = context.__typename === 'StatusContext' ? null : context.startedAt;
  return value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
}

// gh's eliminateDuplicates: newest first by startedAt, then the first
// context per name (status contexts) or per name/workflow/event (check runs).
function eliminateDuplicates(contexts: readonly CheckContext[]): CheckContext[] {
  const sorted = contexts
    .map((context, index) => ({ context, index }))
    .sort((left, right) => startedAtMs(right.context) - startedAtMs(left.context) || left.index - right.index)
    .map(({ context }) => context);
  const seenContexts = new Set<string>();
  const seenChecks = new Set<string>();
  const unique: CheckContext[] = [];
  for (const context of sorted) {
    if (context.context) {
      if (seenContexts.has(context.context)) continue;
      seenContexts.add(context.context);
    } else {
      const workflowRun = context.checkSuite?.workflowRun;
      const key = `${context.name ?? ''}/${workflowRun?.workflow?.name ?? ''}/${workflowRun?.event ?? ''}`;
      if (seenChecks.has(key)) continue;
      seenChecks.add(key);
    }
    unique.push(context);
  }
  return unique;
}

export function bucketFor(state: string): Check['bucket'] {
  switch (state) {
    case 'SUCCESS':
      return 'pass';
    case 'SKIPPED':
    case 'NEUTRAL':
      return 'skipping';
    case 'ERROR':
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'ACTION_REQUIRED':
      return 'fail';
    case 'CANCELLED':
      return 'cancel';
    default:
      return 'pending';
  }
}

// gh's aggregateChecks.
export function aggregateChecks(contexts: readonly CheckContext[]): Check[] {
  return eliminateDuplicates(contexts).map((context) => {
    let state = context.state ?? '';
    if (state === '') state = context.status === 'COMPLETED' ? (context.conclusion ?? '') : (context.status ?? '');
    const workflowRun = context.checkSuite?.workflowRun;
    return {
      name: context.name || context.context || '',
      state,
      startedAt: goTime(context.__typename === 'StatusContext' ? null : context.startedAt),
      completedAt: goTime(context.completedAt),
      link: context.detailsUrl || context.targetUrl || '',
      bucket: bucketFor(state),
      event: workflowRun?.event ?? '',
      workflow: workflowRun?.workflow?.name ?? '',
      description: context.description ?? '',
    };
  });
}

// `gh pr view --json statusCheckRollup` output: every context, flattened.
export function rollupEntries(contexts: readonly CheckContext[]): Record<string, unknown>[] {
  return contexts.map((context) =>
    context.__typename === 'StatusContext'
      ? {
          __typename: 'StatusContext',
          context: context.context ?? '',
          state: context.state ?? '',
          targetUrl: context.targetUrl ?? '',
          startedAt: goTime(context.createdAt),
        }
      : {
          __typename: context.__typename,
          completedAt: goTime(context.completedAt),
          conclusion: context.conclusion ?? '',
          detailsUrl: context.detailsUrl ?? '',
          name: context.name ?? '',
          startedAt: goTime(context.startedAt),
          status: context.status ?? '',
          workflowName: context.checkSuite?.workflowRun?.workflow?.name ?? '',
        },
  );
}
