import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// gh's config directory, as go-gh resolves it.
function ghConfigDirectory(): string {
  if (process.env.GH_CONFIG_DIR) return process.env.GH_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, 'gh');
  if (process.platform === 'win32' && process.env.AppData) return join(process.env.AppData, 'GitHub CLI');
  return join(homedir(), '.config', 'gh');
}

// The hosts gh is signed in to: the top-level keys of its hosts.yml.
export function parseHostsYaml(text: string): string[] {
  return text
    .split('\n')
    .map((line) => /^([^\s#][^:]*):\s*(?:#.*)?$/.exec(line)?.[1]?.trim())
    .filter((host): host is string => Boolean(host));
}

// gh's default host, as go-gh picks it: GH_HOST, else the only host gh is
// signed in to, else github.com. Reads no network and no token.
export function defaultHost(): string {
  if (process.env.GH_HOST) return process.env.GH_HOST.toLowerCase();
  let hosts: string[] = [];
  try {
    hosts = parseHostsYaml(readFileSync(join(ghConfigDirectory(), 'hosts.yml'), 'utf8'));
  } catch {
    // No hosts.yml: gh is not signed in, or uses only environment tokens.
  }
  return hosts.length === 1 ? (hosts[0] as string).toLowerCase() : 'github.com';
}
