# Developer and Technical Handover Guide

This guide gives a new maintainer the shortest safe path to understand, verify, release, and recover the Capstone Impact Platform. It references authoritative documents instead of duplicating detailed contracts.

## Source-of-truth order

1. Executable code, migrations, and tests on the reviewed `main` commit.
2. Tracked repository guidance in `AGENTS.md`, `CONTRIBUTING.md`, and `START_HERE.md`.
3. Cross-system architecture and operational documents under `docs/`.
4. Supabase configuration, migrations, and governed runbooks under `infra/supabase/`.
5. Historical `Prototype/` evidence only. Do not add active functionality there or connect it to the Admin/CMS.

The active application is `apps/admin-cms` (Next.js 16 and TypeScript). Supabase provides PostgreSQL, Auth, and Storage. The approved-only public JSON feed is the integration boundary consumed by the Duda presentation layer.

## Repository maintenance map

| Concern | Authoritative location |
| --- | --- |
| Application routes and UI | `apps/admin-cms/src/app/`, `apps/admin-cms/src/components/` |
| Authentication, authorization, CSRF | `apps/admin-cms/src/auth/`, `apps/admin-cms/src/security/` |
| Server environment contract | `apps/admin-cms/src/lib/env.ts` and target-identity helpers |
| Import workflow | `apps/admin-cms/src/import/`, import routes, import repositories |
| Review and project workflow | `apps/admin-cms/src/workflow/`, project repositories/services, migration RPCs |
| Participant preview | `apps/admin-cms/src/previews/`, preview routes/services, migrations |
| Publication and public feed | `apps/admin-cms/src/projects/`, `apps/admin-cms/src/feed/`, `docs/public-feed-contract.md` |
| Liveness/readiness/hosted smoke | `apps/admin-cms/src/app/api/health`, `apps/admin-cms/src/app/api/readiness`, `apps/admin-cms/src/deployment/` |
| M6 evidence command | `apps/admin-cms/src/operations/m6OperationalReadiness.ts` |
| Recovery verifier | `apps/admin-cms/src/scripts/verifyLocalRecoveryReadiness.ts` |
| Database source | `infra/supabase/migrations/` |
| Local Supabase configuration | `infra/supabase/config.toml`, `infra/supabase/local-development.md` |
| Hosted reconciliation | `infra/supabase/staging-reconciliation-runbook.md` |
| Deployment contract | `docs/admin-cms-hosted-deployment.md` and `docs/m6-operational-readiness.md` |

## Local setup

Use the pinned Node `24.14.1`, npm `11.11.0`, repository Supabase CLI, Docker, and synthetic fixtures:

```bash
npm ci
npm run onboarding:check
npm run setup:local
npm run dev:admin
```

Follow `START_HERE.md` and `infra/supabase/local-development.md`. Preserve the pre-task Local Supabase state. Do not use a hosted project for normal development, and never use real participant/staff identity data.

`npm run supabase:reset` is a destructive Local development command and is not part of the M6 recovery drill. `supabase db push` and `supabase migration repair` are not normal development/release commands and require governed hosted authorization.

## Canonical validation gates

For source changes, the normal PR gates are:

```bash
npm run test:admin
npm run typecheck:admin
npm run build:admin
npm run lint --workspace=apps/admin-cms
npm run check:operational-readiness
git diff --check
```

Use focused tests while editing, then run full gates once the change is stable. Runtime verifiers are evidence for their exact named boundary; none should be generalized to production acceptance.

## Migration discipline

- Migrations already on `origin/main` are immutable and forward-only.
- Add one new timestamped SQL file under `infra/supabase/migrations/` when a schema change is required.
- Inspect later migrations before changing a function: many functions are deliberately redefined by forward migrations.
- Update the exact manifest in `hostedDeploymentReadiness.ts`; its tests require byte-identical historical files and exact inventory equality.
- Update truthful current counts/status in operational documents touched by the change.
- Test migration SQL through existing static/security tests and an approved disposable Local runtime.
- Never edit hosted tracking history or apply hosted migrations from a normal coding task.

Before a hosted change, compare current repository history with the governed hosted history and exact schema/grant evidence. `/api/readiness.expectedMigrations` proves what the deployed bundle expects, not what the database has applied.

## Environment separation and secrets

- Local/disposable Supabase is loopback-only and is the normal verification target.
- Admin/CMS staging, historical staging/fallback, Prototype recovery, and any future production project are separate targets.
- Runtime identity and expected-host checks fail closed; never weaken them to make a script pass.
- Browser-safe variables and server-only credentials have different boundaries. Server secrets must never be prefixed `NEXT_PUBLIC_`.
- Record only environment variable names in Git. Store values in the institution-approved secret/configuration system.
- Never print, log, screenshot, copy into commands, or commit secret values, private URLs, signed URLs, preview tokens, or user identities.

See `apps/admin-cms/src/lib/env.ts`, `docs/admin-cms-hosted-deployment.md`, `infra/supabase/key-migration-governance.md`, and the M6 configuration inventory.

## Render deployment contract

The Admin/CMS web service uses repository root, `npm ci`, `npm run build:admin`, `npm run start --workspace=apps/admin-cms`, and health path `/api/readiness`. `/api/health` is liveness only. Render must expose a valid exact `RENDER_GIT_COMMIT` for deployment identity evidence.

There is no tracked Render Blueprint. The paid assistive background worker it once defined is withdrawn: Render documents no free instance type for background workers, so that shape carried a permanent monthly charge. Assistive execution now runs either as a zero-cost on-demand executor or as a School-owned continuous worker; see [Zero-Cost Assistive Executor](operations/zero-cost-assistive-executor.md). Do not repurpose the Prototype service or infer Admin/CMS web-service configuration from any worker definition.

Deployment, redeploy, rollback, environment changes, private dashboard access, and DNS are institutional operator actions. Follow the pre/post gates and rollback procedure in `docs/m6-operational-readiness.md`.

## Duda and publication boundary

The Admin/CMS database/lifecycle is administrative truth. The immutable public deployment ledger and exact stable Storage feed are deployment truth. Duda is the presentation consumer. These layers can intentionally differ after a controlled feed rollback, so do not rebuild deployment membership from lifecycle rows or edit the feed by hand.

Live Duda cutover is not authorized by normal application work. Public-feed writes, staging publication, Duda verification, and live publication require their specific environment policy and approval. Read `docs/public-feed-contract.md` and `docs/duda-integration-plan.md` before touching that boundary.

## Recovery maintenance

The Local recovery verifier is intentionally narrow. It may destroy only the randomly named schema and bucket whose current execution proves ownership. It never resets the database, mutates canonical tables/buckets, writes backups to the repository, or contacts hosted Supabase.

Run it only under `docs/system-recovery-readiness.md`, preserve the pre-task stack state, and label the result `LOCAL_RECOVERY_MECHANICS_VERIFIED`. Hosted database, Storage, configuration, Render, DNS, and Duda recovery require the supervised M6 plan and must not be inferred from the Local result.

When changing the verifier, preserve and test ownership proof, post-loss authority revocation, competitor-resource refusal, cleanup-on-failure, canonical-resource non-mutation, repeat execution, and loopback-only targeting.

## Evaluate a release

1. Identify the exact reviewed full SHA and verify CI on that SHA.
2. Run the offline and JSON forms of `npm run check:operational-readiness`.
3. Complete the unchecked [M6 release checklist](m6-release-acceptance-checklist.md) with evidence references.
4. Reconcile hosted migration/schema evidence separately from HTTP readiness.
5. Have an authorized operator deploy the exact SHA.
6. Run the credential-free hosted M6 smoke with the exact expected commit.
7. Complete applicable integrated workflow, security, recovery, monitoring, documentation, training, and ownership gates.
8. Obtain independent review and institutional sign-off. Do not self-merge or self-declare KPI completion.

## Institution-dependent capabilities at handover

The repository does not select or own:

- institutional GitHub, Render, Supabase, DNS, Duda, email/provider, and monitoring accounts;
- production backup cadence/retention, encryption/access policy, or restore target;
- real secret values, rotation custody, billing, support windows, or alert destinations;
- hosted restore, redeploy/rollback, alert-routing, and RPO/RTO evidence;
- staff account approvals, human training results, or named operational owners.

Track these as `TBD — STAKEHOLDER DECISION REQUIRED` in the handover template. Do not invent names or use a participant-owned personal account as the institutional owner.
