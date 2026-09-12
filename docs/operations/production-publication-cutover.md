# Production publication machine boundary and cutover runbook

**Candidate state:** `CODE_PATH_AVAILABLE_DISABLED` (qualification pending)

**Scope:** production public-feed execution code and a later institution-owned live Duda cutover

**Activation status:** disabled by default; no production host, project identity, approval, value, or live URL is established here

This runbook is the production-only supplement to the staging-focused deployment, Duda, and
handover documents. The earlier application could write only to Local or an explicitly enabled
staging/test-showcase target. Pointing live Duda at that staging feed would have made the Admin/CMS
warning false and reused staging authority for production. The production target introduced here
provides a reviewable candidate code path without activating or contacting any live system. It must
not be labelled `MACHINE_GAP_CLOSED` until exact-head CI, independent release review, hosted identity
proof, institutional approval, and the separately authorized live cutover are complete.

## Machine boundary

Production publication is a distinct named target. All of these server-side conditions must hold
at the same time:

1. `CAPSTONE_RUNTIME_ENV` is exactly `production`;
2. `CAPSTONE_EXPECTED_SUPABASE_HOST` is a canonical hostname and exactly matches the hostname of
   `NEXT_PUBLIC_SUPABASE_URL`;
3. the Supabase URL is canonical HTTPS, remote, credential-free, and has no port, path, query, or
   fragment;
4. `CAPSTONE_PRODUCTION_PUBLICATION_ENABLED` is exactly `true`;
5. the request is same-origin and the authenticated server-derived staff identity has the required
   publication or archive permission; and
6. feed bucket, feed path, public-assets bucket, and private-draft bucket come only from server
   configuration.

The staging flag cannot substitute for the production flag, a staging runtime cannot execute a
production target, and a production runtime cannot execute a staging target. Missing, padded,
case-variant, malformed, loopback, mismatched, or disabled values fail closed. With the production
flag absent or false, production publish/removal/activation/reconciliation/recovery execution is
unavailable. The production Admin/CMS shell is labelled **Production** and does not display the
staging promise that the public showcase is unaffected.

The following names belong in the institution-owned host configuration; values do not belong in
Git:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (or the governed legacy public-key fallback)
- `SUPABASE_SECRET_KEY` (or the governed temporary legacy server-key fallback)
- `CAPSTONE_AUTH_FLOW_SECRET`
- `CAPSTONE_RUNTIME_ENV`
- `CAPSTONE_EXPECTED_SUPABASE_HOST`
- `CAPSTONE_PRODUCTION_PUBLICATION_ENABLED`
- `SUPABASE_DRAFT_BUCKET`
- `SUPABASE_PUBLIC_ASSETS_BUCKET`
- `SUPABASE_PUBLIC_FEEDS_BUCKET`
- `SUPABASE_PUBLIC_FEED_FILE`
- the hosting provider's exact deployment-commit identity variable

No Duda credential is used by the Admin/CMS. Duda remains a read-only presentation client of one
stable public feed URL. No Duda API integration or application-side Duda call is required.

## Preserved publication semantics

Production publication, removal, deployment reconciliation, activation, and explicit forward
recovery all use the existing unified canonical writer. They retain:

- approved-only readiness and an exact participant-confirmed snapshot;
- a fresh no-write publication plan followed by server-side readiness revalidation;
- one globally exclusive durable operation with lease, owner-token, epoch, and uncertainty fencing;
- immutable version/member/event history and an explicit deployment head;
- deterministic public-media promotion only after durable `WRITE_STARTED` intent;
- exact canonical UTF-8 JSON, byte count, SHA-256, record count, and read-after-write verification;
- target-specific idempotent completion evidence;
- archive/removal from the exact current head without deleting media; and
- forward convergence of the exact bound candidate after an ambiguous or interrupted write.

No schema change is needed. The current ledger already stores environment-neutral operation intent,
canonical destination, immutable versions, membership, head, recovery state, and rollback-capability
evidence.

## Production rollback decision

Production feed-history rollback is deliberately **unavailable**. The current rollback proof is
bounded to explicitly enabled disposable Local execution. Production activation records rollback
capability as false, and production cannot prepare, execute, or recover a rollback operation. This
must not be widened by a staging rollback change without a separate production proof and decision.

Supported production recovery is forward-only:

- an interrupted canonical write is recovered from its durable bound candidate through
  **Publishing > Recover publishing status** after the lease and uncertainty fence permit takeover;
- a wrong individual project is removed through governed production removal, or a lifecycle-
  published but undeployed exact record is restored through deployment reconciliation;
- application release rollback uses the separately governed hosting rollback procedure and does not
  reverse database migrations, project lifecycle, or public-feed head; and
- database/Storage loss uses the institution-approved backup/restore procedure and must restore a
  coherent database ledger, feed bytes, public assets, and configuration. Storage-only replacement
  or hand-editing `capstones-latest.json` is prohibited.

The live presentation cutover itself has a separate reversible boundary: before changing Duda,
record the exact pre-cutover Duda renderer/configuration revision and prior consumer configuration.
If the new consumer fails acceptance, the authorized Duda operator restores that exact pre-cutover
configuration. Never point live Duda at the staging feed as a rollback.

## Institution-authorized cutover

The orchestrator or institutional operators perform these actions later. Repository validation does
not authorize them.

### 1. Release and ownership gates

1. Record the exact reviewed full source SHA, clean CI, independent approval, and a schema-compatible
   last-known-good application SHA.
2. Complete institutional ownership for the production Supabase project, Admin/CMS host, Duda site,
   DNS if applicable, backups, monitoring, incident response, and primary/backup operators.
3. Apply and independently verify the exact repository migration history and Gate 4 schema/grant/RLS
   contract on the production Supabase project. Stop on any mismatch; do not repair history casually.
4. Prove a release-appropriate database plus all canonical Storage buckets can be restored to an
   isolated target. Production acceptance must not be inferred from the existing staging-origin
   rehearsal.
5. Record the canonical production feed bucket/path and the stable public URL in the institution's
   protected change record, not in Git.
6. Confirm the Duda operator has live publishing authority and capture the exact pre-cutover Duda
   configuration/revision for consumer rollback.

### 2. Deploy disabled and verify identity

1. Configure a separate production Admin/CMS service and School-controlled Supabase project. Do not
   repurpose the Prototype or staging service/project.
2. Set the production runtime identity and expected host, but keep
   `CAPSTONE_PRODUCTION_PUBLICATION_ENABLED=false`.
3. Deploy the exact reviewed SHA. Verify `/api/health`, `/api/readiness`, the exact deployment SHA,
   login, production environment banner, migration evidence, and the agreed authenticated workflow
   smoke. `/api/readiness` is only a configuration/dependency signal, not schema or acceptance proof.
4. Confirm direct POSTs to the production publication and removal routes return the bounded
   unavailable response while the flag is false. Do not probe by attempting an actual publication.

### 3. Establish the production feed

1. Open an approved publication change window and record the publication owner, recovery owner,
   independent reviewer, monitoring recipient, and Duda owner.
2. Set `CAPSTONE_PRODUCTION_PUBLICATION_ENABLED=true` and redeploy/restart through the institution's
   configuration procedure. Re-run exact-SHA readiness and identity checks.
3. In **Publishing**, establish history only if it is not already active. Activation succeeds only
   when an existing canonical object exactly matches the lifecycle-published projection, or when
   both the object and projection are empty. Any mismatch stops cutover.
4. For each intended record, require approved status, exact participant confirmation, authoritative
   readiness `READY`, a fresh publication plan, production acknowledgement, and one controlled
   production publication.
5. After each write, record the operation result, version/head, public ID, record count, exact byte
   count, SHA-256, snapshot/audit evidence, and stable feed URL. Fetch the stable object with cache
   bypass, verify its bytes/hash/count against the head, validate the public-feed contract, and
   inspect that only intended public fields and members are present.
6. If `RECOVERY_REQUIRED`, an unknown response, unexpected bytes, or head/Storage disagreement
   occurs, stop all publication/removal/reconciliation work. Use only the bounded recovery control
   for the exact blocking operation, then repeat exact head/Storage verification. Do not blindly
   retry or edit Storage.

### 4. Point live Duda at the stable feed

1. With production feed/head agreement already proved, the authorized Duda operator sets the live
   renderer's single feed setting to the recorded production stable feed URL. No secret, signed URL,
   private bucket, or staging URL is permitted.
2. Publish/republish Duda only under the institution's live change authorization.
3. Verify cache-bypassed feed HTTP success, expected SHA-256 and count, listing, all four facets,
   public-field search, reusable detail navigation, poster/PDF/gallery alternatives, mobile no-
   overflow, and representative accessibility checks. Confirm an unknown public ID and no-match
   search use the bounded unavailable/empty states.
4. Have the independent reviewer confirm the live presentation corresponds to the exact recorded
   feed head. Feed completion alone is not Duda acceptance.

### 5. Prove removal and close the window

1. Use a separately approved production record or the institution's agreed cutover fixture. Enter a
   reason, acknowledge the live effect, and execute governed production removal once.
2. Verify the project is archived, removal is no longer pending, exact Storage bytes match the new
   head/hash/count, the target is absent, unrelated members are unchanged, and public media was not
   deleted.
3. Refresh live Duda with cache bypass and confirm the target is absent from listing, search, facets,
   and its former detail route.
4. Set `CAPSTONE_PRODUCTION_PUBLICATION_ENABLED=false` after the window unless the institution has
   explicitly approved continuous availability. Verify production mutation routes are unavailable
   again and record the final exact SHA/head/feed evidence.

## A-06 staging rollback integration boundary

A-06 may extend rollback capability for a separately gated staging target. It may need to integrate
changes around public-feed history dependencies, history controls, and rollback policy. Integration
must preserve all of these production invariants:

- production never inherits a staging rollback flag, acknowledgement, capability bit, route, or UI;
- production activation continues to request `rollbackCapability=false`;
- a blocking production rollback operation remains `RECOVERY_REQUIRED`, not executable;
- production publish/removal/activation/reconciliation/forward-recovery continue to require the
  production flag and exact production identity; and
- staging and Local behavior retain their own existing identities and controls.

If A-06 cannot preserve those invariants without changing the production decision, stop integration
and require a separate adjudication. Do not duplicate A-06's staging rollback implementation here.
