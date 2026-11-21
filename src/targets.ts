export type PullRequestTarget = {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  readonly number: number;
};

export type RepositoryTarget = {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
};

export class UsageError extends Error {}

// Accepts a pull request URL or `[host/]owner/repo#number`.
export function parsePullRequestTarget(value: string, defaultHost = 'github.com'): PullRequestTarget {
  const shorthand = /^(?:([^/\s#]+)\/)?([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(value);
  if (shorthand) {
    const [, host, owner, name, number] = shorthand;
    return { host: host ?? defaultHost, owner: owner as string, name: name as string, number: Number(number) };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`Not a pull request URL or owner/repo#number: ${value}`);
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/.exec(url.pathname);
  if (!match) throw new UsageError(`Not a pull request URL: ${value}`);
  return {
    host: url.hostname.toLowerCase(),
    owner: decodeURIComponent(match[1] as string),
    name: decodeURIComponent(match[2] as string),
    number: Number(match[3]),
  };
}

// Accepts `[host/]owner/repo` or a repository URL.
export function parseRepositoryTarget(value: string, defaultHost = 'github.com'): RepositoryTarget {
  if (/^https?:\/\//.test(value)) {
    const url = new URL(value);
    const [owner, name] = url.pathname.split('/').filter(Boolean);
    if (!owner || !name) throw new UsageError(`Not a repository URL: ${value}`);
    return { host: url.hostname.toLowerCase(), owner, name: name.replace(/\.git$/, '') };
  }
  const parts = value.split('/').filter(Boolean);
  if (parts.length === 2) return { host: defaultHost, owner: parts[0] as string, name: parts[1] as string };
  if (parts.length === 3) return { host: (parts[0] as string).toLowerCase(), owner: parts[1] as string, name: parts[2] as string };
  throw new UsageError(`Not a repository (expected owner/repo): ${value}`);
}

export function repositoryKey(target: { owner: string; name: string }): string {
  return `${target.owner}/${target.name}`.toLowerCase();
}

export function pullRequestUrl(target: PullRequestTarget): string {
  return `https://${target.host}/${target.owner}/${target.name}/pull/${target.number}`;
}
