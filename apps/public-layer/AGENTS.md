# Public Layer Boundary

`apps/public-layer` is the active maintained source for the Duda public presentation layer.

- Keep the renderer assets/templates and synthetic contract fixtures in this package.
- Keep `apps/admin-cms` authoritative for editorial data, the public-feed schema/validator,
  and publication decisions. Do not duplicate feed or database authority here.
- Harnesses may use only synthetic data and loopback browser servers. Never add live Duda
  calls, publish/republish endpoints, hosted-service access, credentials, or publication
  configuration.
- Preserve renderer behavior and fixture semantics unless a separately scoped renderer change
  is requested. The browser harnesses are repository checks, not Duda deployment tooling.
- `Prototype/` is historical evidence only. Do not modify, delete, or redirect current checks
  back to its renderer or scripts.
