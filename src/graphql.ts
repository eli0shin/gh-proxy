import type { GitHubClient, GraphQLError } from './github.ts';
import { describeError } from './engine.ts';

export type BatchSelection = {
  // Variable name suffix -> [GraphQL type, value].
  readonly variables: Record<string, readonly [string, unknown]>;
  // The aliased field, written with `$<suffix>` for its variables, e.g.
  // `repository(owner: $owner, name: $name) { ... }`.
  readonly field: string;
};

export type AliasOutcome = { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: string };

// Runs one aliased GraphQL query per chunk of selections. Every query asks
// for its rate limit cost, which GitHub reports at no extra cost.
export async function runBatched(
  client: GitHubClient,
  operation: string,
  selections: readonly BatchSelection[],
  options: { readonly fragments?: string; readonly chunkSize: number; readonly heartbeat?: () => void },
): Promise<AliasOutcome[]> {
  const outcomes: AliasOutcome[] = [];
  for (let offset = 0; offset < selections.length; offset += options.chunkSize) {
    const chunk = selections.slice(offset, offset + options.chunkSize);
    const definitions: string[] = [];
    const fields: string[] = [];
    const variables: Record<string, unknown> = {};
    chunk.forEach((selection, index) => {
      const alias = `a${index}`;
      let field = selection.field;
      for (const [suffix, [type, value]] of Object.entries(selection.variables)) {
        const variable = `${alias}_${suffix}`;
        definitions.push(`$${variable}: ${type}`);
        variables[variable] = value;
        field = field.replace(new RegExp(`\\$${suffix}\\b`, 'g'), `$${variable}`);
      }
      fields.push(`${alias}: ${field}`);
    });
    const query = `query ${operationName(operation)}${definitions.length > 0 ? `(${definitions.join(', ')})` : ''} {
  rateLimit { cost remaining resetAt }
  ${fields.join('\n  ')}
}
${options.fragments ?? ''}`;
    try {
      const response = await client.graphql(operation, query, variables, chunk.length);
      chunk.forEach((_, index) => {
        const alias = `a${index}`;
        const error = response.errors.find((candidate) => errorAlias(candidate) === alias);
        const data = response.data?.[alias];
        if (error && (data === null || data === undefined || isNotFound(error))) {
          outcomes.push({ ok: false, error: errorMessage(error) });
        } else if (data === undefined) {
          // A query that fails validation has no data at all.
          const first = response.errors[0];
          outcomes.push({ ok: false, error: first ? errorMessage(first) : 'GitHub returned no data' });
        } else {
          outcomes.push({ ok: true, data });
        }
      });
    } catch (error) {
      const message = describeError(error);
      for (const _ of chunk) outcomes.push({ ok: false, error: message });
    }
    options.heartbeat?.();
  }
  return outcomes;
}

// Runs a single (unbatched) query and throws on any GraphQL error.
export async function runQuery<T>(
  client: GitHubClient,
  operation: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await client.graphql(operation, query, variables, 1);
  if (response.errors.length > 0) throw new Error(errorMessage(response.errors[0] as GraphQLError));
  return response.data as T;
}

export type PageInfo = { readonly hasNextPage: boolean; readonly endCursor: string | null };
export type Connection<T> = {
  readonly totalCount?: number;
  readonly pageInfo?: PageInfo;
  readonly nodes: readonly (T | null)[];
};

// Reads the pages of a node's connection after the first, which the caller
// already has. `connection` is the field name, e.g. `comments`.
export async function remainingNodes<T>(
  client: GitHubClient,
  operation: string,
  target: { readonly id: string; readonly typeName: string; readonly connection: string; readonly fields: string },
  first: Connection<T>,
  heartbeat?: () => void,
): Promise<T[]> {
  const nodes = first.nodes.filter((node): node is T => node !== null);
  let pageInfo = first.pageInfo;
  while (pageInfo?.hasNextPage) {
    const data = await runQuery<{ node: Record<string, Connection<T>> }>(
      client,
      operation,
      `query ${operationName(operation)}($id: ID!, $after: String) { node(id: $id) { ... on ${target.typeName} {
        ${target.connection}(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${target.fields} } }
      } } }`,
      { id: target.id, after: pageInfo.endCursor },
    );
    const page = data.node[target.connection];
    if (!page) break;
    nodes.push(...page.nodes.filter((node): node is T => node !== null));
    pageInfo = page.pageInfo;
    heartbeat?.();
  }
  return nodes;
}

// Execution errors' paths start at the alias; validation errors' paths start
// at the operation, e.g. ["query GhpSearch", "a0", ...].
function errorAlias(error: GraphQLError): string | number | undefined {
  const [first, second] = error.path ?? [];
  return typeof first === 'string' && first.startsWith('query ') ? second : first;
}

function isNotFound(error: GraphQLError): boolean {
  return error.type === 'NOT_FOUND';
}

function errorMessage(error: GraphQLError): string {
  return error.type === 'NOT_FOUND' ? `not found: ${error.message}` : error.message;
}

function operationName(operation: string): string {
  return `Ghp${operation.replace(/(^|[^a-zA-Z0-9])([a-zA-Z0-9])/g, (_, __, character: string) => character.toUpperCase())}`;
}
