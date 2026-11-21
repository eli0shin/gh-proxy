# ghp

A shared, cached, batched GitHub reader for tools that poll pull requests.

Many processes watching the same pull requests with `gh` each send their own requests, so the GitHub rate limit is spent once per process. `ghp` replaces those reads with purpose-built commands. All processes share one local cache, and only one process at a time sends GitHub requests for each kind of read. Because that process fetches every stale key in a few batched queries, the number of processes polling no longer changes the request count.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/eli0shin/gh-proxy/main/install.sh | bash
```

The installer puts `ghp` in `~/.local/bin`. Run it again to update.

Requirements:

- x64 or arm64 macOS, or glibc Linux.
- [GitHub CLI](https://cli.github.com/) authenticated with `gh auth login`. `ghp` reads its token with `gh auth token --hostname <host>`, unless `GH_TOKEN`/`GITHUB_TOKEN` (github.com) or `GH_ENTERPRISE_TOKEN` (other hosts) is set. `ghp` never stores the token.

## How a read works

Every read has a max age (`--max-age <seconds>`, with a default for each command):

1. **Cache hit:** if the cached value is younger than the max age, `ghp` returns it with no GitHub request.
2. **Refresh lease:** otherwise the process tries to take the refresh lease for that kind of read. Only one process holds the lease at a time.
3. **Batched refresh:** the lease holder fetches the keys it was asked for. It also fetches every key that any process asked for in the last 10 minutes and that is past half its max age. Pull requests go about 30 to a GraphQL query.
4. **Waiting:** processes without the lease wait for the refresh and then read its results.
5. **Max age 0:** returns only data from a request sent after the call started. Use it right after a mutation, such as a push or merge. Concurrent callers still share one request.
6. **Failures:** a failed fetch keeps the last good value. Readers get it back with `stale: true` and the error.
7. **Rate limits:** when GitHub rate-limits a request, every process stops sending requests until the reset time and serves cached data instead. The same happens when fewer than `GHP_RESERVE` requests are left (default 200), so the agents' own `gh` commands keep some headroom.

The cache is SQLite at `~/Library/Caches/ghp/cache.db` on macOS and `~/.cache/ghp/cache.db` on Linux. `GHP_DB` overrides the path. Cache keys include the host and a fingerprint of the token, so accounts never share entries.

## Commands

Each command prints JSON.

- Commands that take several targets print an array, in argument order.
- Commands that take a single target print a single object.

Each result has this shape:

```json
{ "target": "...", "value": { ... }, "fetchedAt": 1795232579025, "stale": false, "error": null }
```

`value` is `null` only when nothing was ever fetched successfully; `error` says why.

| Exit status | Meaning |
| --- | --- |
| 0 | Every result has a value. |
| 3 | At least one result has no value. |
| 2 | Usage error. |
| 1 | Any other failure. |

| Command | Replaces | Default max age |
| --- | --- | --- |
| `ghp pr status <url\|owner/repo#n>...` | `gh pr view` + `gh pr checks` + the REST comment, review, and review-comment lists | 60s |
| `ghp pr find [owner/repo] [branch...] [--dir path]` | `gh pr view <branch>`, or `gh pr view` in a checkout | 60s |
| `ghp pr details <url>` | Review's details reads: `gh pr view --json` metadata, reviews, statusCheckRollup, comments, plus review threads | 15s |
| `ghp search <query> [--size n] [--after cursor]` | A Review Queue page plus one `gh pr view` per row | 60s |
| `ghp branch-tip <owner/repo> <branch>...` | `gh api repos/{repo}/commits/{branch}` | 60s |
| `ghp runs <owner/repo> <sha>...` | `gh run list --commit <sha>` | 60s |
| `ghp repo [owner/repo] [--dir path]` | `gh repo view --json nameWithOwner,url,defaultBranchRef` | 24h |
| `ghp whoami [--host host]` | `gh api user` | 24h |
| `ghp invalidate <url>...` | Marks a pull request's cached reads stale | — |
| `ghp stats [--since minutes]` | GitHub requests, points, and cache reads by operation and consumer | — |

Every read command also accepts:

- `--wait <seconds>`: how long to wait for another process's refresh.
- `--consumer <name>`: a name recorded in the request log. Defaults to `$GHP_CONSUMER`.

### `pr status`

`value` holds:

- **PR fields:** `state`, `isDraft`, `headRefName`, `headRefOid`, `headRepository`, `baseRefName`, `author`, `mergeable`, `mergeCommit`, `mergedAt`, `reviewDecision`, `reviewRequests`.
- **`checks`:** exactly what `gh pr checks --json name,state,startedAt,completedAt,link,bucket,event,workflow,description` prints. That means the newest run of each check, gh's buckets, and Go zero times for missing timestamps. `checks` is `[]` when the head commit has no checks; `gh pr checks` exits with an error in that case.
- **`issueComments` and `reviews`:** the newest 100 of each. They always include any activity since the previous poll. `issueCommentsTotal` and `reviewsTotal` give the full counts.
- **`reviewComments`:** every submitted inline review comment.
- **Activity format:** each activity has its REST `id` (as a string) and an `author` with `login`, `type`, and `isBot`. Bot logins keep the `[bot]` suffix REST uses. One exception: REST names Copilot's inline comments `Copilot`, while `ghp` names them `copilot-pull-request-reviewer[bot]`.

Inline review comments are the expensive part of a pull request read. `ghp` fetches them again only when a thread or comment count changed, or after 15 minutes.

## Cost

Measured on github.com:

| Read | Before (gh) | With ghp |
| --- | --- | --- |
| One poll of 40 pull requests | ~120 GraphQL + 120 REST requests | 2 points |
| One Review Queue page of 25 | 26 GraphQL requests | 1 point |
| Pull request details | 5+ GraphQL requests | 1 point |

Because every process shares the same refresh, these costs do not grow with the number of processes polling.

## Development

```bash
bun install
bun run typecheck
bun test           # against a fake GitHub server, including concurrent processes
bun run parity     # compares ghp with gh on live pull requests (needs gh auth)
bun run build      # compiles ./ghp
```

Releases use changesets: add one with `bunx changeset`. Merging the version PR tags the release, and CI attaches a binary for each platform, built on that platform.
