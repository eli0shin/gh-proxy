# gh-proxy

## 0.1.0

### Minor Changes

- Initial release of `ghp`: a shared, cached, batched GitHub reader. Commands `pr status`, `pr find`, `pr details`, `search`, `branch-tip`, `runs`, `repo`, `whoami`, `invalidate`, and `stats` replace the per-process `gh` reads of PR Watch, Review, and agent-status. A cross-process SQLite cache with single-flight refresh leases and a shared rate-limit gate means one batched request per kind of read, however many processes poll.
