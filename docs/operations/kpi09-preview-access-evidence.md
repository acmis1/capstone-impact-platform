# KPI-09 preview access and response evidence

This report is a read-only staff/operator export for preview versions issued in an exact half-open
UTC cohort: `created_at >= issued-from` and `created_at < issued-before`. It reports at most 100
preview versions per page, ordered stably by issuance timestamp and preview UUID. It never writes,
confirms, approves, publishes, or changes workflow state.

Run it only from the reviewed Admin/CMS environment, as an authorized staff operator with the
server-side Supabase configuration already loaded. Do not paste keys into the command or save the
output in the repository:

```powershell
npm.cmd run report:kpi09-preview-evidence -- --issued-from=2026-09-01T00:00:00Z --issued-before=2026-10-01T00:00:00Z --limit=100 --acknowledge-read-only-kpi09
```

If `nextCursor` is present, repeat with its two values as
`--cursor-issued-at=<issuedAt> --cursor-preview-id=<previewId>`. Rates and the 95% response-prepared
and 90% on-time-confirmation targets are classified only when one bounded page contains the whole
cohort (`completeCohort: true`). For a larger cohort, retain every page in the controlled evidence
location and calculate the cohort totals from all pages; do not treat a page rate as the cohort rate.

The export contains preview UUID, project public ID, issuance/expiry, lifecycle state, first complete
server-response preparation, exact-preview confirmation, correction state/timestamps, and bounded
exception codes. It excludes raw tokens and token hashes, email addresses, Auth identities, IP
addresses, user agents, participant names, and provider text.

Interpretation is deliberately limited:

- `firstResponsePreparedAt` means the server finished preparing a successful HTML GET and persisted
  the first such observation. It is not a delivery receipt, read receipt, or proof of human identity;
  bots and prefetch can qualify.
- `RESPONSE_PREPARATION_NOT_RECORDED` means no observation exists. It does not prove no access,
  because migration 55 performs no retroactive backfill.
- On-time confirmation means an explicit exact-preview confirmation timestamp no later than that
  preview's expiry. A correction request is reported separately and is not converted to confirmation.
- Evidence is retained with its owning preview and is deleted only when that preview is deleted under
  the existing project/preview retention lifecycle. Export copies must follow the same restricted
  operational retention and access policy as other Admin/CMS evidence.
- A report/query failure is `KPI09_EVIDENCE_UNAVAILABLE`, distinct from a successfully read row whose
  evidence is not recorded. Never convert unavailable evidence into a zero, pass, or inferred event.
