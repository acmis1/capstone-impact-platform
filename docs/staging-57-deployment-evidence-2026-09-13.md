# PP1 Staging-57 Deployment Evidence — 2026-09-13

This is the current technical handover record for active staging-v2. It records read-only evidence
and the authorized forward migration/deployment sequence; it does not authorize future hosted
mutation, publication, email, or institutional acceptance.

## Identity and migration qualification

- Supabase target: `capstone-admin-cms-staging-v2-2026`, project ref
  `sqkpceeltukbzxpsvinb`, PostgreSQL 17, `ap-southeast-1`.
- Render service: `capstone-admin-cms-staging-v2`; auto-deploy remains off.
- Documentation baseline at evidence capture: `88a24958cd541a513e99dc72cb522ded658129fc`; later documentation-only commits may advance `main` without changing the staged runtime implementation SHA.
- Runtime implementation deployed to staging: `90646e084f827e399617078b21a91dee3e899799`.
- Migration history advanced from an exact 52-row prefix to 57 rows. A dry run listed exactly
  Migrations 53–57, and all five applied successfully in order, with no migration repair:

  1. `20260909120000_staff_lifecycle_readiness.sql`
  2. `20260910120000_public_feed_rollback_capability.sql`
  3. `20260910120100_participant_preview_access_observations.sql`
  4. `20260910120200_assistive_worker_production_identity.sql`
  5. `20260911120000_gallery_full_text_equivalents.sql`

- Latest migration is `20260911120000_gallery_full_text_equivalents`.
- Pre- and post-migration application/data aggregates were unchanged. The pre-window baseline was
  9 projects, 35 media assets, 2 admin users, 3 role rows, 6 participant previews, 9 public-feed
  versions, 5 published snapshots, 30 approval records, and 2 Auth users. Storage held 36 private
  draft objects, 19 public-asset objects, and a 2-byte canonical feed.

## Structural evidence

Fresh hosted Gate-4 catalog totals matched the repository contract:

- 48 tables = 45 public application tables + 3 non-public execution-control tables;
- 558 columns, 420 constraints, and 35 policies;
- 92 service-role application RPC signatures across 91 names;
- 1 canonical staff-role helper, 4 dispatcher-control routines, and 4 Storage buckets.

The exact repository/disposable comparison at implementation SHA `90646e08` returned
`GATE4_CLASSIFICATION=GATE4_MATCH`, with migrations, tables, columns, constraints, RLS, policies,
grants, RPC signatures/names, helpers, dispatcher routines, and buckets matching. The hosted
collector was read-only, but its large hosted JSON snapshot was not persisted as an on-disk formal
comparator artifact. This evidence therefore must not claim that such a hosted artifact file exists.
Gate 4 proves structural parity for the collected contract only; it does not prove row contents,
Auth identities, Storage contents, recovery, monitoring, deployment identity, or UAT.

## Deployment and credential-free smoke

- Final live Render deployment: `dep-daj4mjdg1s2s739dhjl0`.
- `/api/health` GET/HEAD: 200.
- `/api/readiness` GET/HEAD: 200, `classification=READY`, configuration `configured`, dependency
  `reachable`, database capability `current`, expected migration count 57, and latest Migration 57.
- `/login` GET: 200.
- Unauthenticated `/admin`: 307 redirect to `/login?redirectTo=/admin`.
- `HOSTED_SMOKE_CLASSIFICATION=READY_FOR_SUPERVISED_UAT`.
- `M6_OPERATIONAL_READINESS_CLASSIFICATION=READ_ONLY_HOSTED_CHECK_PASSED`.
- `HOSTED_MUTATIONS=NONE`.

An earlier exact-SHA deployment attempt while staging was still at 52 migrations timed out because
readiness correctly rejected the old database capability. Build and application start succeeded;
this was fail-closed readiness behavior, not an application build failure. After Migrations 53–57,
the same implementation SHA deployed successfully and the maintenance gate was explicitly reopened.

## Advisor, feed, and external side effects

The post-migration security advisor showed no unexpected finding family. The accepted items remain:
intentional `RLS_ENABLED_NO_POLICY` INFO findings on service/RPC-only tables; the known P3 mutable
`search_path` warning on `public.update_updated_at_column()`; intentional self-bound authenticated
SECURITY DEFINER warnings for `get_current_password_recovery_session_state()` and the expected
`staff_session_is_active()` warning after Migration 53; and hosted provider/plan configuration for
leaked-password protection, which is not claimed enabled.

The canonical staging feed remains exactly `[]` (2 bytes; SHA-256
`4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`). Participant-preview
notification rows and reminder schedule rows are both 0. No real email was sent, no Duda mutation
occurred, no live Impact publication occurred, and no cloud-feed publication call was made.

## Migration-57 gallery consequence

Migration 57 performed no accessibility-content backfill. Staging contains 17 snapshot/gallery
assets across 4 approved and 5 archived projects whose gallery content kind/full text remains
undeclared. This is intentional, not data corruption: project teams must author corrected package
content before a future governed review/publication reconciliation can pass. No declarations or
full-text values may be fabricated.

## Qualification boundary

This record does not establish:

- BRIEF-SC01 comparable human elapsed-time and person-hour measurement;
- BRIEF-SC03 institutional acceptance of a near-zero threshold;
- BRIEF-SC04 human/native assistive-technology testing or formal WCAG acceptance;
- BRIEF-SC05 real-provider or intended-participant UAT;
- BRIEF-SC06 / BRIEF-18 authorized live Impact/Duda deployment or institutional acceptance.

Read-only Auth-foundation inspection found 2 admin users linked to Auth, 3 recognized role
assignments, 0 invalid roles, 0 linked staff without a recognized role, and all 30 approval records
with an actor. This is structural evidence only and is not human login or UAT evidence.
