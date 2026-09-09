# Staff Lifecycle Operations and Recovery

This runbook describes the executable staff lifecycle introduced by
`20260909120000_staff_lifecycle_readiness.sql`. PostgreSQL is the authoritative Admin/CMS
authorization boundary. Supabase Auth disable/enable is a separate provider synchronization step.

## Lifecycle contract

- Only a live, active Administrator whose resolved permissions include `staff.manage` may use the
  same-origin lifecycle API. The database repeats the active-Administrator check before writing.
- A role replacement is the complete recognized role set, not an additive patch. The only roles
  are `admin`, `reviewer`, and `editor`; duplicates are canonicalized and unknown roles fail closed.
- Deactivation atomically sets `admin_users.lifecycle_status = 'deactivated'`, removes all effective
  role rows, advances `lifecycle_version`, and appends an audit event. Every Admin request resolves
  this database state, so retained or still-valid Auth tokens cannot grant Admin/CMS access.
- Reactivation is a distinct authorized action and requires a non-empty recognized role set. It
  restores database authorization before attempting to re-enable provider sign-in.
- Staff, Auth linkage history, and lifecycle audit rows are not hard-deleted. If an Auth identity is
  independently deleted, its staff profile remains and the linkage becomes null.
- Self-role changes and self-deactivation are denied. There is no bypass in this workflow: another
  effective Administrator must perform the change.
- Removing or deactivating an effective Administrator is globally serialized and cannot reduce the
  effective Administrator population below one. Pending invitations and profiles without a linked
  Auth identity do not count as effective and cannot act.
- Every real transition requires the displayed `lifecycle_version`. A stale writer receives a
  deterministic conflict; an exact repeat receives a no-change/already-current result.
- Every real role or lifecycle transition appends one durable operational event. Its identity,
  actor/target snapshots, action, before/after roles and status, lifecycle version, and creation
  timestamp are immutable. Only the bounded provider-reconciliation fields on that row may change,
  and only through the token-fenced claim/completion routines. Ordinary UI and logs never expose
  profile IDs, Auth IDs, provider response detail, or reconciliation tokens.

Existing invitation and staging test-account flows remain unchanged. An invitation that is still
`pending_activation` remains denied by the existing activation gate.

## Provider synchronization semantics

For deactivation, the server attempts a long-duration Supabase Auth ban. For reactivation, it
attempts an explicit unban. Provider work starts only after the authoritative database transaction
commits.

The lifecycle event has one of four provider states:

- `not_required`: a role-only transition required no provider call.
- `pending`: a token-fenced provider attempt owns a two-minute lease.
- `succeeded`: provider state was recorded as synchronized.
- `failed`: database authorization remains authoritative and staff UI reports attention required.

A provider failure never compensates or restores database authorization. While the current version
has pending/failed provider work, further lifecycle transitions are blocked. An authorized operator
uses **Retry sign-in sync**; the database issues a new expiring claim only after the prior claim has
failed or expired. Completion accepts only the matching one-time token. Tokens are stored only as
SHA-256 hashes and are never returned to the browser.

The event history is append-only: reconciliation never replaces or deletes an event. Its controlled
provider fields (`provider_status`, attempt count, claim lease/token hash, failure code, and last
attempt time) record the fenced provider workflow on the original transition row; ordinary table
updates remain unavailable.

## Deployment and preflight

1. Back up the database under the existing managed recovery procedure.
2. Confirm there are no duplicate staff emails after trimming and case-folding. The migration
   deliberately fails transactionally if identity addressing would be ambiguous.
3. Confirm at least two effective Administrators exist and are not pending activation.
4. Apply the reserved forward-only migration before deploying application code that reads
   `lifecycle_status` or `lifecycle_version`.
5. Run the focused migration/unit/API/UI tests and the disposable Local Supabase verifier:

   ```text
   npm run verify:staff-lifecycle-runtime:disposable
   ```

6. After application deployment, have two Administrators independently confirm Staff access loads,
   then perform a governed non-admin role replacement and verify its audit/provider status.

The migration is transactional. A migration-time failure leaves the prior schema unchanged. Do not
deploy the new application against that unchanged schema.

## Recovery

- If provider synchronization fails, leave database lifecycle state unchanged and retry from the
  Staff access UI after the provider is healthy. Do not manually restore roles to hide the failure.
- If an operator loses their own Auth access, a different effective Administrator performs the
  governed action. Hosted dashboard or direct database mutation is not part of this workflow.
- If only one effective Administrator remains, lifecycle changes affecting that identity must stop
  until the separately governed bootstrap/recovery process establishes another effective admin.
- Never roll back to an application build that predates the `lifecycle_status` authorization check
  while any staff row is deactivated; that older build could ignore the authoritative deny state.
  If application rollback is unavoidable, retain the lifecycle gate or take the Admin/CMS offline.
- Do not drop lifecycle columns/events or recreate deleted role rows as a rollback. Recovery is
  forward-only: correct the application/provider fault, reconcile provider state, and use an
  explicit audited reactivation when access should genuinely return.

The lifecycle event table is service-readable for the bounded staff directory but grants no direct
insert/update/delete privileges. `anon` receives no table or routine access. `authenticated` may
execute only the session predicate needed by catalog RLS, not lifecycle mutation or audit routines.
