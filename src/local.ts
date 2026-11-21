import { UsageError, type RepositoryTarget } from './targets.ts';

async function git(directory: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const subprocess = Bun.spawn(['git', '-C', directory, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { code, stdout, stderr };
}

// Parses SSH, scp-like, and HTTPS remote URLs.
export function parseRemoteUrl(url: string): RepositoryTarget | undefined {
  const trimmed = url.trim();
  let host: string;
  let path: string;
  const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  if (/^[a-z+]+:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    host = parsed.hostname;
    path = parsed.pathname;
  } else if (scpLike) {
    host = scpLike[1] as string;
    path = scpLike[2] as string;
  } else {
    return undefined;
  }
  const [owner, name] = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').split('/');
  if (!owner || !name) return undefined;
  host = host.toLowerCase();
  // gh treats GitHub's SSH-over-443 host as github.com.
  if (host === 'ssh.github.com') host = 'github.com';
  return { host, owner, name };
}

const REMOTE_PRIORITY = ['upstream', 'github', 'origin'];

// gh's base repository: the remote marked `gh-resolved` by `gh repo
// set-default`, else upstream, github, origin, then any other remote.
export async function localRepository(directory: string): Promise<RepositoryTarget> {
  const result = await git(directory, ['config', '--get-regexp', '^remote\\..*\\.(url|gh-resolved)$']);
  if (result.code !== 0 && result.stdout.trim() === '') {
    throw new UsageError(`No git remotes found in ${directory}`);
  }
  const remotes = new Map<string, { url?: string; resolved?: string }>();
  for (const line of result.stdout.split('\n')) {
    const match = /^remote\.(.+)\.(url|gh-resolved) (.+)$/.exec(line.trim());
    if (!match) continue;
    const [, name, kind, value] = match as unknown as [string, string, 'url' | 'gh-resolved', string];
    const remote = remotes.get(name) ?? {};
    if (kind === 'url') remote.url ??= value;
    else remote.resolved = value;
    remotes.set(name, remote);
  }
  for (const remote of remotes.values()) {
    if (!remote.resolved || !remote.url) continue;
    const parsed = parseRemoteUrl(remote.url);
    if (!parsed) continue;
    if (remote.resolved === 'base') return parsed;
    const [owner, name] = remote.resolved.split('/');
    if (owner && name) return { host: parsed.host, owner, name };
  }
  const ordered = [...remotes.keys()].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
  for (const name of ordered) {
    const url = remotes.get(name)?.url;
    const parsed = url ? parseRemoteUrl(url) : undefined;
    if (parsed) return parsed;
  }
  throw new UsageError(`No GitHub remote found in ${directory}`);
}

function rank(remote: string): number {
  const index = REMOTE_PRIORITY.indexOf(remote);
  return index < 0 ? REMOTE_PRIORITY.length : index;
}

// The current branch's name on GitHub: its upstream branch when it tracks one
// under another name, as gh pr view does.
export async function localBranch(directory: string): Promise<string> {
  const current = await git(directory, ['branch', '--show-current']);
  const branch = current.stdout.trim();
  if (current.code !== 0 || !branch) {
    throw new UsageError(`Could not resolve the current branch in ${directory}: ${current.stderr.trim() || 'detached HEAD'}`);
  }
  const merge = await git(directory, ['config', `branch.${branch}.merge`]);
  const upstream = merge.stdout.trim().replace(/^refs\/heads\//, '');
  return merge.code === 0 && upstream ? upstream : branch;
}
