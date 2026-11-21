# gh-proxy: one shared, batched GitHub reader for PR Watch, Review, and agent-status

## Problem

Every Pi/OpenCode session runs its own PR Watch poller, and every Review TUI instance runs its own refresh. Each one calls general-purpose `gh` commands per PR. When the same 30 PRs are watched by workers, orchestrators, and review sessions at once, the requests multiply by the number of sessions, and the GraphQL limit (5,000 points/hour) stays exhausted.

## Inventory of current GitHub traffic

I measured the counts below with `GH_DEBUG=api` on gh 2.105.0. "GQL" means one network GraphQL request (≥1 point). `gh pr checks` sends 4 requests, but 2 of them are feature-detection introspection that gh serves from its disk cache.

### Pi PR Watch (`~/.dotfiles/home/.pi/agent/extensions/pr-watch.ts`)

Poll interval: `max(60s, watchedPrs × 30s)`, capped at 10 min (`pollIntervalMs`). That works out to about 2 PR polls per minute for each session.

| Call site | Command | Cost |
|---|---|---|
| `pollPr` | `gh pr view <url> --json headRefOid,headRefName,headRepository,state,author,mergeable,mergeCommit,mergedAt` | 1 GQL |
| `fetchChecks` (poll + baseline) | `gh pr checks <url> --json name,state,bucket,workflow,link,completedAt` | 2 GQL (`PullRequestByNumber` + `PullRequestStatusChecks`) |
| `fetchActivities` | `gh api repos/{r}/issues/{n}/comments`, `pulls/{n}/reviews`, `pulls/{n}/comments` with `If-None-Match` | 3 REST, free on 304 |
| `discover`, `discoverWorkerPr` (workers with no PR yet run this on every poll) | `gh pr view [url\|branch] --json number,url,headRefName,headRefOid,headRepository,state,author,mergeable,mergeCommit,mergedAt` | 1 GQL |
| `discoverInOtherDirectory` | `gh pr view --json url,state` in another cwd | 1 GQL |
| `remoteBranchTip` (branch-tip watch, every poll) | `gh api repos/{r}/commits/{branch}` (no ETag) | 1 REST |
| `fetchRunsForSha` (every poll while a SHA is watched) | `gh run list --commit <sha> -R <repo> --json …` (no ETag) | 1 REST |
| `ensureCurrentRepo`, `defaultBranchFor` | `gh repo view --json nameWithOwner,defaultBranchRef` | 1 GQL, cached per process |
| `refreshSelfLogin` | `gh api user` | 1 REST, cached per process |

A PR poll costs about 3 GQL, so a session costs about 6 GQL/min (≈360/hour) no matter how many PRs it watches.

Membership multiplies this further:
- An orchestrator watches every worker PR, and each worker also watches its own.
- Any `gh pr view <url>` enrolls that PR (`isActivationCommand`). So every Review Command session (`pi "review … $REVIEW_PR_URL"`) adds an observer poller for its PR.

### OpenCode PR Watch (`~/.dotfiles/home/.config/opencode/lib/pr-watch-core.ts`)

This poller uses the same commands on a fixed 60s interval for **every** watched PR, so it costs N × 3 GQL/min. Its activity calls carry no ETags, so they spend REST quota too.

### agent-status (`~/.dotfiles/home/.agents/skills/agent-status/scripts/agent-status`)

It runs per PR, on demand: `gh pr view` (1 GQL), `gh pr checks` (2 GQL), and `gh api …/reviews --paginate` (REST). That fetches the same data PR Watch already has.

### Review TUI (`~/code/code-review-tui/src/github/cli/`)

- `review-queue.ts`/`search.ts`: one GraphQL `search` per page, plus one more search per Stack that has layers missing from the page.
- `queue-enrichment.ts`: `gh pr view <url> --json additions,deletions,changedFiles,reviewDecision,reviews,statusCheckRollup` for **each** row (25 per page, 8 concurrent). That is 26+ GQL per refresh, every 5 min per instance, and again for each page and list toggle.
- `pull-request-details.ts`: 4 × `gh pr view` (metadata, reviews, statusCheckRollup, comments), plus paginated review-thread GraphQL. That is 5+ GQL each time details open.
- `current-repository.ts`: `gh repo view`.
- Mutations: `gh pr review`, `gh pr view --web`.

### Rough total on a day like this week's

With 15–20 Pi sessions polling, PR Watch alone uses about 5,000–7,000 GQL/hour, above the 5,000-point limit before Review, agent-status, or the agents' own ad-hoc `gh` calls are added. The underlying data is about 30 distinct PRs.

## Batching: measured costs

I ran aliased `repository(...){pullRequest(number:)}` queries in one request and read `rateLimit { cost }`:

| Query | PRs | Cost |
|---|---|---|
| Summary: state, head oid, mergeable, merge commit, rollup state, comment/review/thread counts | 6 | 1 |
| Summary | 40 | 1 |
| Full PR Watch snapshot: summary + every check context (name, status, conclusion, workflow, link, times) + `comments(last:100)` + `reviews(last:100)` with `databaseId` and author `__typename` | 6 | 1 |
| Full snapshot | 40 | **2** |
| Full snapshot + `reviewThreads(last:100){comments(last:50)}` | 6 | 6 (≈1 per PR) |

Today one poll of 40 PRs costs about 120 GQL plus 120 REST. The full snapshot replaces it with 2 points. Only inline review comments are expensive, because the nested connection drives the cost. Fetch them only for PRs whose cheap fields changed (see "two-tier refresh").

GraphQL exposes everything PR Watch reads:
- `databaseId` on IssueComment, PullRequestReview, and PullRequestReviewComment matches the REST `id`. The existing `issue-comment:<id>`-style activity IDs stay valid.
- `author { __typename }` returns `Bot`, so the REST `user.type` lookup is not needed for bot filtering.

## Precedent

- **Kubernetes `ghproxy`/`ghCache`** (Prow): a shared HTTP cache for the GitHub API. It serves many components from one cache and coalesces concurrent identical requests into a single upstream call. It revalidates every hit with ETags, because a 304 costs no REST quota. Its scope is REST; it does not batch or reshape GraphQL.
- **TanStack Query / SWR**: the client behavior proposed here: `staleTime`/max-age, deduplication of in-flight requests, and stale data served when the fetch fails.
- **Go `singleflight`**: the standard name for "concurrent callers of one key wait for one fetch."
- **`gh api --cache <dur>`**: gh's own disk cache. I confirmed it caches GraphQL POSTs (second call: 0.3 ms). It keys on the exact request, has no coalescing and no cross-process batching, and only `gh api` supports it. It is still usable as a stopgap.
- **gh `http_unix_socket` config**: routes all `gh` HTTP through a local socket. This could later bring agents' ad-hoc `gh` calls under the same cache and rate-limit gate without changing their commands.

## Design

### Shape: a purpose-built CLI over a shared SQLite cache, no daemon

`ghp` is a Bun/TypeScript compiled binary, built and installed the same way as `review`. Every consumer already shells out, so a CLI fits all three, including agent-status, which is Python. Each command is one domain operation that returns JSON. Internally it is one batched GraphQL query, or an ETag'd REST call where REST is free.

There is no daemon. Coordination runs through SQLite in WAL mode at `~/Library/Caches/ghp/cache.db` (mode 0600; it holds private PR data). Tokens come from `gh auth token --hostname <h>` and are never stored.

The cache key always includes host and viewer login, because visibility differs by account.

### Freshness, single-flight, and cross-process batching

Each read carries `--max-age <seconds>` (defaults per operation):

1. Record interest: `interest(resource_key, last_requested_at = now)`.
2. If the cached row is younger than max-age, return it.
3. Otherwise try to take the refresh lease for the resource class and host (`leases` row with holder pid and `expires_at`; `BEGIN IMMEDIATE`).
   - **Got the lease:** select every key in the class that was requested in the last ~10 min and is older than a refresh threshold (for example, half the max-age). That pulls everyone's nearly-stale PRs into this tick. Fetch them in chunks of about 40 per query, write the rows, then release the lease.
   - **Lease held by another process:** wait for release (poll about every 100 ms; an expired lease can be taken over), then re-read. If this key was added after the holder took its snapshot, repeat once.
4. Return rows with `fetchedAt` and `stale`. If GitHub errors, return the last good row with `stale: true` and the error.

The interest table acts as a subscription list. Twenty processes that each want different subsets of the same 30 PRs therefore produce one query per minute, not twenty.

### Shared rate-limit gate

Each response records `x-ratelimit-remaining/reset` and `retry-after` in SQLite. While the gate is closed, every caller gets stale data and nobody calls GitHub. Today every session keeps retrying while rate-limited, which keeps the limit pinned.

### Two-tier refresh for expensive fields

- Tier 1 (every tick, all interested PRs): the full snapshot without thread comments, at about 1 point per 20–40 PRs.
- Tier 2 (only PRs whose `updatedAt`, `reviews.totalCount`, or `reviewThreads.totalCount` changed): inline review comments, at about 1 point per changed PR.

Every inline comment, reply included, belongs to a PullRequestReview, so `reviews.totalCount` should catch replies. Verify this during implementation.

REST stays where 304s are free: workflow runs for a SHA, and paginated comment lists if they are needed. `ghp` adds the ETags those calls are missing today.

### Operations (CLI surface)

| Command | Replaces | Default max-age |
|---|---|---|
| `ghp whoami [--host]` | `gh api user` | 24h |
| `ghp repo [--dir <path>]` | `gh repo view --json nameWithOwner,defaultBranchRef`; name from the git remote, default branch cached | 24h |
| `ghp pr status <url…>` | `gh pr view` + `gh pr checks` + 3 activity calls (PR Watch poll, agent-status). Returns state, draft, head ref/oid/repo, author, mergeable, merge commit, mergedAt, reviewDecision, reviewRequests, checks (latest run per check, with gh's `bucket`/`state`), activity (`kind:id`, author, isBot) | 60s |
| `ghp pr find --repo <r> --branch <b>` | `gh pr view <branch>`, `discoverWorkerPr`, `discoverInOtherDirectory`; batched as `pullRequests(headRefName:, states:OPEN)` | 60s |
| `ghp branch tip <repo> <branch…>` | `gh api repos/{r}/commits/{branch}`; batched via `ref(qualifiedName:)` | 60s |
| `ghp runs <repo> <sha>` | `gh run list --commit`; REST with ETag | 60s |
| `ghp search <query> [--size --after]` | Review Queue search + per-row enrichment. The enrichment fields move into the search query itself; Stack-layer lookups stay as searches | 60s |
| `ghp pr details <url>` | Review details: 4 × `gh pr view` + review threads, as one query plus pagination when needed | 15s |
| `ghp invalidate <url…>` | Called after mutations (`gh pr merge/review/create`, push) so the next read refetches | — |

Mutations stay on `gh`. `--max-age 0` forces a refetch that is still coalesced; PR Watch uses it right after a merge, a push, or `gh pr create`.

### Parity requirements (where this can go wrong)

- **Activity IDs:** keep the exact `issue-comment:<id>` / `review:<id>` / `review-comment:<id>` strings from REST `id` (`databaseId`). Persisted `seenActivityIds` must stay valid, or every old comment notifies again after the switch. Keep PENDING reviews and the ignored-author filtering as they are.
- **Checks:** reproduce `gh pr checks` exactly: latest run per check name, `bucket` (pass/fail/pending/skipping/cancel), and `state`. Write a parity harness that runs `gh pr checks` and `ghp pr status` against a set of live PRs and diffs the results.
- **Pagination:** today's REST activity calls fetch only `per_page=100` oldest-first, so new activity on busy PRs is silently missed. Use `last:100` and paginate on `hasPreviousPage`; paginate check contexts beyond 100.
- **`mergeable: UNKNOWN`** is GitHub computing lazily. Treat it as non-definitive, as `isDefinitiveMergeable` already does.
- **GHE hosts:** Review already supports `--hostname`. Key everything by host.

## Expected effect

Steady state, for any number of sessions watching about 30 PRs:
- about 1–2 points/min for tier 1;
- plus about 1 point per PR that actually changed;
- plus REST revalidations that mostly return free 304s.

That is roughly 100–200 points/hour, against about 5,000+ today. Pi PR Watch can also drop the `× 30s per PR` back-off and poll every 60s, so notifications arrive faster.

## Rollout

0. **Stopgaps (optional, small):**
   - In Review, fold the enrichment fields into the search query: 26 → 1 GQL per refresh.
   - In OpenCode PR Watch, adopt Pi's interval scaling.
1. **`ghp` core:** SQLite schema (`entries`, `interest`, `leases`, `rate_gate`), lease and single-flight logic, `pr status`, `whoami`, `repo`, the parity harness, and a request log (operation, consumer tag, cost, status). The log lets us see the remaining sources of usage.
2. **Pi PR Watch:**
   - Replace `pollPr`, `fetchChecks`, `fetchActivities`, `discover*`, `remoteBranchTip`, and `fetchRunsForSha`.
   - Pass `--max-age 0` after mutations.
   - Remove the per-PR interval scaling.
3. **OpenCode PR Watch and agent-status.**
4. **Review TUI:** `search` and `pr details` behind its existing `GitHub` adapter interface (`src/github/types.ts`).
5. **Later, if the request log shows it matters:** route agents' ad-hoc `gh` through `http_unix_socket` to a coalescing proxy. Consider notification-based change detection.

## Open decisions

1. **Daemon or daemon-less.** Recommended: daemon-less SQLite with leases. It needs no lifecycle management or launchd agent, and it is crash-safe because leases expire. A daemon becomes worth it only if consumers should get push events instead of polling.
2. **Default max-ages.** Proposed: 60s for watch data and 15s for details the user opens.
3. **Repo and name.** Proposed: `~/code/gh-proxy` as its own repo with a binary named `ghp`, released like `review`.
4. **Ad-hoc agent `gh` calls.** Bring them in scope now (http_unix_socket) or measure them first with the request log?
