# Staging 48→51 Maintenance-Gate Addendum

**Status:** Release-specific operational addendum for the authorized staging-v2 48→51 transition.

**Applies to:** `capstone-admin-cms-staging-v2` / Supabase ref `sqkpceeltukbzxpsvinb`.

**Base rollout plan:** [Staging Migrations 0049–0051 Rollout Plan](staging-migrations-49-51-rollout.md).

This addendum exists because the reviewed rollout plan requires normal staff/participant mutation traffic to remain unavailable from before Migration 0049 through successful H2, while the free Render footprint does not provide a suitable native maintenance mode. It does **not** authorize a migration, deployment, Duda/publication operation, email, or data deletion by itself.

For this release only, the sequencing rules below supersede the conflicting wording in sections E, G and H2 of the base rollout plan. Every other safety rule, migration order, verification requirement, forward-only rule and Duda boundary in the base plan remains unchanged.

## 1. Application maintenance gate

The Admin/CMS implements a fail-closed request gate controlled by the server-side environment variable:

```text
CAPSTONE_STAGING_MAINTENANCE_MODE=true
```

Only the exact literal string `true` enables the gate. No other truthy spelling is accepted.

While enabled, only these exact read-only H2 surfaces are permitted:

| Path | Allowed methods |
| :--- | :--- |
| `/api/health` | `GET`, `HEAD` |
| `/api/readiness` | `GET`, `HEAD` |
| `/login` | `GET`, `HEAD` |

Everything else intercepted by the Next.js proxy returns fixed `HTTP 503 Service Unavailable` with `Cache-Control: no-store`, `Retry-After: 300` and `X-Capstone-Maintenance: staging-rollout`.

The blocking decision occurs before application route handling and before normal Admin/CMS database or service-role work. The gate contains no migration/schema lookup, so blocked traffic is safe while the hosted database is at migration state 48, 49, 50 or 51.

The application uses `src/app`, so the executed Next.js Proxy convention file is `apps/admin-cms/src/proxy.ts`. The historical root-level `apps/admin-cms/proxy.ts` is outside the active convention location for this source layout. The maintenance implementation intentionally preserves the currently observed disabled-mode application behaviour rather than silently introducing the previously intended session-refresh proxy during a database rollout.

## 2. Coverage boundary

The maintenance gate blocks Admin/CMS pages, project/import/staff/deployment surfaces, API mutations, participant-preview reads and responses, password-reset pages/actions, Server Actions and all non-allowlisted application requests.

The browser Supabase client has only two direct Auth-provider paths in the current repository: the forgot-password request and legacy recovery-session bridge. The forgot-password page is blocked while maintenance is enabled. A legacy recovery fragment can still establish provider-side Auth state if a user already possesses such a link, but the follow-up application action is blocked and those provider-side Auth calls do not touch the tables, RPCs or Storage buckets changed by migrations 0049–0051. This residual does not authorize normal application workflow traffic.

Hosted assistive execution is a separate writer and must be verified quiescent before the migration window. A stale heartbeat is not, by itself, authority to ignore a live worker; read the execution-control state immediately before the window and stop if a live registration/reservation or fresh worker activity appears.

## 3. Controlled transition sequence

The safe sequence for this release is:

1. Re-read `main`, Render deployment identity and hosted Supabase state. Complete fresh read-only Gates 1–5 from the base rollout plan.
2. Reconfirm the already-accepted pre-upgrade 48-state recovery evidence and verify the hosted assistive execution surface is quiescent.
3. Record the exact reviewed release commit that contains this gate and whose CI is green.
4. Set `CAPSTONE_STAGING_MAINTENANCE_MODE=true` **before** deploying the reviewed release commit.
5. Deploy the exact reviewed release candidate. Auto-deploy remains off.
6. Before any migration, verify the closed window by observation:
   - `GET /api/health` → ordinary HTTP 200;
   - `GET /api/readiness` → ordinary readiness response for the target;
   - `GET /login` → ordinary login surface;
   - `GET /admin` → HTTP 503 with the maintenance marker;
   - one representative mutation `POST` → HTTP 503 with the maintenance marker.
   If any expected maintenance result is absent, **do not apply Migration 0049**.
7. Apply only `20260902010606_controlled_project_links_import.sql`; then run its database-only history/effect/preservation verification.
8. Apply only `20260903120000_participant_preview_controlled_links.sql`; then run its database-only history/effect/preservation verification.
9. Apply only `20260903130000_participant_owned_corrections.sql`; then complete H1 exactly as specified in the base plan.
10. With maintenance mode still enabled, complete H2 against the already-running reviewed application. H2 uses only the three allowlisted read-only surfaces.
11. Only after every H2 check passes, set `CAPSTONE_STAGING_MAINTENANCE_MODE=false` (or remove the variable) and allow the resulting restart/redeploy to complete.
12. Re-run the bounded hosted smoke and verify `/admin` returns its ordinary unauthenticated redirect rather than the maintenance 503.
13. Restore normal staff workflow access only after step 12 passes.
14. Duda TEST/UAT remains a later separately governed step. **No live Duda publication is authorized by this addendum.**

## 4. Why the 51-contract application is deployed before Migration 0049

The maintenance gate is application code, so the existing older staging build cannot enforce it. The reviewed release candidate therefore has to be deployed before the database transition begins.

This does **not** mean the 51-contract application is allowed to operate normally against the 48-state database. It is permitted only in the verified closed state described above. Blocked routes do not reach schema-dependent application logic. In that historical build, the three allowlisted H2 surfaces were bounded: health did not query the database, readiness used the baseline `public.programs` dependency probe, and the login surface did not exercise correction tables/RPCs/buckets.

That readiness description is historical to the 51-contract build. The current endpoint instead
requires a valid provider deployment commit and calls the immutable, read-only release capability
sentinel RPC; it cannot be green against this older 48-state database.

The operational invariant is therefore:

> The 51-contract application must not serve normal workflow traffic before the database reaches Migration 0051 and H1 succeeds.

If the maintenance flag is misconfigured or the 503 check fails, stop before Migration 0049. Do not weaken a validator, bypass the gate, or continue on the assumption that users are idle.

## 5. H1 remains authoritative

H1 is unchanged and must prove the database itself before the application is accepted:

- 51 / 51 migration versions, latest `20260903130000`;
- 41 public application tables plus 3 execution-control tables;
- 84 service-role application RPC signatures across 83 names;
- 4 non-public dispatcher routines with their exact security/grant contract;
- 4 canonical Storage buckets, including private `participant-corrections-private` with its exact limit/MIME contract;
- exact RLS, policies, grants and role structure;
- retired legacy correction shortcut returning `PARTICIPANT_CANDIDATE_REQUIRED`;
- preservation of existing data, snapshots, Storage objects/checksums and assistive cost-fence evidence;
- exact Gate 4 structural match.

`/api/readiness` is not migration-history or Gate 4 evidence and cannot replace H1.

## 6. Failure handling

If any migration, H1 check, deployment identity check or H2 check fails:

- keep maintenance enabled;
- preserve the actual forward database state and evidence;
- do not automatically rerun `db push`;
- do not use `supabase migration repair` to make history agree;
- do not roll the application backward to the historical 48-compatible build after 0051;
- do not restore over the hosted source in place;
- stop and diagnose the smallest failed invariant before the next consequential operation.

Recovery remains a separately governed isolated-restore/cutover decision, not an in-place downgrade.

## 7. Explicit exclusions

This addendum does not authorize or introduce:

- live Duda publication;
- `/api/publish-cloud-feed` use;
- participant email delivery;
- public-feed/content mutation for demonstration purposes;
- paid Render upgrades;
- migration repair;
- destructive database restore;
- deletion of Supabase assets;
- weakening of Auth, RLS, validation, publication or participant-authority contracts.
