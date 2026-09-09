# Active Public Layer

This package is the maintained source of truth for the repository-owned Duda public
presentation layer.

- `duda/` contains the Duda renderer assets/templates and the synthetic current-feed
  contract fixture/cases.
- `scripts/` contains the feed URL validator and the current-feed and annual-scale browser
  harnesses. They serve synthetic assets over loopback only and do not publish to Duda.
- `apps/admin-cms` remains the source of truth for editorial records, feed schema validation,
  and controlled publication. This package is Duda presentation only; it does not own feed
  data, database logic, publication authority, or production configuration.
- `Prototype/` is an immutable historical reference snapshot. Current tests and CI must use
  this package, not the historical files.

No live Duda call, Duda publish/republish endpoint, hosted service, credential, or runtime
dependency is required by this package.
