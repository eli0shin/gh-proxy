---
'gh-proxy': minor
---

Targets without a host now use gh's default host: `GH_HOST`, else the only host gh is signed in to, else github.com. Before, they always used github.com, so an account signed in only to GitHub Enterprise could not search or use `owner/repo` targets without `--host`. Processes that open a new cache at the same moment no longer fail with `database is locked`.
