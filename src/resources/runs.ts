import type { FetchContext, FetchOutcome, ResourceClass } from '../engine.ts';
import { describeError } from '../engine.ts';
import { repositoryKey } from '../targets.ts';

type RunsParams = { readonly owner: string; readonly name: string; readonly sha: string };

// `gh run list --json` fields.
export type WorkflowRun = {
  readonly attempt: number;
  readonly conclusion: string;
  readonly createdAt: string;
  readonly databaseId: number;
  readonly displayTitle: string;
  readonly event: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly name: string;
  readonly number: number;
  readonly startedAt: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly url: string;
  readonly workflowDatabaseId: number;
  readonly workflowName: string;
};

type RestRun = {
  id: number;
  name: string | null;
  display_title: string | null;
  run_attempt: number | null;
  conclusion: string | null;
  status: string | null;
  created_at: string;
  updated_at: string;
  run_started_at: string | null;
  event: string;
  head_branch: string | null;
  head_sha: string;
  run_number: number;
  html_url: string;
  workflow_id: number;
};

const WORKFLOWS_MAX_AGE_MS = 60 * 60_000;

export const workflowRuns: ResourceClass<RunsParams> = {
  name: 'runs',
  keyOf: (params) => `${repositoryKey(params)}@${params.sha.toLowerCase()}`,
  async fetch(batch, context) {
    const outcomes = new Map<string, FetchOutcome>();
    for (const item of batch) {
      const { owner, name, sha } = item.params;
      try {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100&exclude_pull_requests=true`;
        const previousRuns = item.previous?.value as WorkflowRun[] | null | undefined;
        const response = await context.client.rest('runs', path, previousRuns ? item.previous?.etag ?? null : null);
        if (response.status === 304 && previousRuns) {
          outcomes.set(item.key, { ok: true, value: previousRuns, etag: item.previous?.etag ?? null });
        } else {
          const runs = (response.body as { workflow_runs: RestRun[] }).workflow_runs;
          const names = await workflowNames(item.params, context);
          outcomes.set(item.key, { ok: true, value: runs.map((run) => toRun(run, names)), etag: response.etag });
        }
      } catch (error) {
        outcomes.set(item.key, { ok: false, error: describeError(error) });
      }
      context.heartbeat();
    }
    return outcomes;
  },
};

// gh run list names a run's workflow from the repository's workflow list.
async function workflowNames(params: RunsParams, context: FetchContext): Promise<Map<number, string>> {
  const key = `workflows|${context.client.host}|${await context.client.fingerprint()}|${repositoryKey(params)}`;
  const previous = context.store.getEntries([key]).get(key);
  const cached = previous?.value as [number, string][] | null | undefined;
  if (cached && Date.now() - previous!.fetchedAt < WORKFLOWS_MAX_AGE_MS) return new Map(cached);
  const requestedAt = Date.now();
  const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.name)}/actions/workflows?per_page=100`;
  const response = await context.client.rest('workflows', path, cached ? previous!.etag : null);
  if (response.status === 304 && cached) {
    context.store.writeSuccess(key, cached, requestedAt, previous!.etag);
    return new Map(cached);
  }
  const workflows = (response.body as { workflows: { id: number; name: string }[] }).workflows;
  const pairs = workflows.map((workflow): [number, string] => [workflow.id, workflow.name]);
  context.store.writeSuccess(key, pairs, requestedAt, response.etag);
  return new Map(pairs);
}

function toRun(run: RestRun, names: Map<number, string>): WorkflowRun {
  return {
    attempt: run.run_attempt ?? 1,
    conclusion: run.conclusion ?? '',
    createdAt: run.created_at,
    databaseId: run.id,
    displayTitle: run.display_title ?? '',
    event: run.event,
    headBranch: run.head_branch ?? '',
    headSha: run.head_sha,
    name: run.name ?? '',
    number: run.run_number,
    startedAt: run.run_started_at ?? run.created_at,
    status: run.status ?? '',
    updatedAt: run.updated_at,
    url: run.html_url,
    workflowDatabaseId: run.workflow_id,
    // A workflow missing from the list was deleted or belongs to a ruleset.
    workflowName: names.get(run.workflow_id) ?? run.name ?? '',
  };
}
