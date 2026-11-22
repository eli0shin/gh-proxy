# gh-proxy

## 0.2.0

### Minor Changes

- [#1](https://github.com/eli0shin/gh-proxy/pull/1) [`c9dcf8e`](https://github.com/eli0shin/gh-proxy/commit/c9dcf8e097ecbd5249f592ff192042037f42946d) Thanks [@eli0shin](https://github.com/eli0shin)! - Targets without a host now use gh's default host: `GH_HOST`, else the only host gh is signed in to, else github.com. Before, they always used github.com, so an account signed in only to GitHub Enterprise could not search or use `owner/repo` targets without `--host`. Processes that open a new cache at the same moment no longer fail with `database is locked`.

## 0.1.0

### Minor Changes

- Initial release of `ghp`: a shared, cached, batched GitHub reader. Commands `pr status`, `pr find`, `pr details`, `search`, `branch-tip`, `runs`, `repo`, `whoami`, `invalidate`, and `stats` replace the per-process `gh` reads of PR Watch, Review, and agent-status. A cross-process SQLite cache with single-flight refresh leases and a shared rate-limit gate means one batched request per kind of read, however many processes poll.
