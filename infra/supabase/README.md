# Staging Supabase Migrations (`infra/supabase`)

This directory contains the version-controlled database schema migrations, policy definitions, local development setup scripts, and operational governance runbooks for the Capstone Admin/CMS platform.

---

## ⚠️ Current Environment & Staging Status

> [!NOTE]
> * **Local Development:** Reproducible local Supabase development is verified on Windows with Docker Desktop via CLI 2.109.1. The current 46-file timestamped migration manifest through `20260828120000_assistive_worker_heartbeat.sql` is the executable repository baseline and passes its automated manifest contract. macOS and Linux remain unverified; independent human verification remains pending. Local development requires **no** Supabase cloud account or organization membership.
> * **Active Hosted Staging (`capstone-admin-cms-staging-v2-2026`):** Point-in-time read-only evidence records 46 rows in `supabase_migrations.schema_migrations`, from earliest `20260601035138` through latest `20260828120000`. This migration-history evidence does not by itself prove exact schema, grant, or RPC parity; those remain separate governed checks.
> * **Historical/Paused Hosted Staging (`capstone-admin-cms-staging-2026`):** This is the environment associated with the old manually evolved migration baseline. Its history must not be confused with the active staging-v2 evidence.
> * **Corrective Fix:** Migration `0006` corrected the initial administrator bootstrap runtime by replacing `pg_catalog.trim` with PostgreSQL standard `pg_catalog.btrim`.
> * **Default Execution Hardening:** Migration `0007` (`20260803174000_harden_function_execute_defaults.sql`) establishes global postgres-owned function default privilege revokes and conditionally revokes execution on the optional hosted RLS helper.
> * **Transactional Review Actions:** Migration `0008` (`20260803180000_transactional_review_actions.sql`) establishes atomic `public.perform_project_review_action` PostgreSQL RPC function for transaction-backed project review status updates and approval audit logging.
> * **Transactional Metadata Update:** Migration `0009` (`20260808170000_transactional_project_metadata_update.sql`) establishes the one-transaction, service-role-only `public.update_project_metadata` RPC for scalar metadata and join-table writes.
> * **Project Metadata Audit Trail:** Migration `0021` (`20260813002154_project_metadata_audit_history.sql`) introduces the project metadata audit trail directly into `approval_records`.
> * **Identity Linkage:** Initial administrator linkage was verified in isolated staging (`READY_FOR_MANUAL_LOGIN_TEST`).
> * **Do Not Rerun:** Do not rerun the migration sequence or initial bootstrap merely because these files exist.
> * **Pending Scope:** Exact hosted schema/grant/RPC verification, hosted staff lifecycle provisioning, reviewer/editor UAT, and production deployment remain pending. Migration alignment must be rechecked for each release candidate.

---

## Local Development Quick Start

Reproducible local Supabase development is fully supported via Docker and the pinned repository CLI. See [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and the [Local Development Guide](./local-development.md) for developer standards and setup instructions.

### Toolchain Contract
- **Node.js**: `>= 24.14.1 < 25` (Pinned via `.nvmrc` to `24.14.1`; Node 24 is the maintained LTS line used for verification)
- **npm**: `>= 11.11.0 < 12` (Declared in `packageManager` as `npm@11.11.0`)

```bash
npm ci
npm run onboarding:check
npm run supabase:start
npm run supabase:reset
npm run supabase:seed:buckets
npm run supabase:env:local
npm run supabase:users:local
npm run supabase:verify:local
```

Clean up when finished:

```bash
npm run supabase:stop
```

---

## Operational Runbooks & Governance

* **[Contributor Guide](../../CONTRIBUTING.md):** Authoritative developer onboarding standards, toolchain contract, and security rules.
* **[Local Development Guide](./local-development.md):** Complete local environment setup, seed fixtures, synthetic staff credentials, and acceptance checklist.
* **[Staging Reconciliation Runbook](./staging-reconciliation-runbook.md):** 7-gate procedure to verify, back up, reconcile, and validate hosted database schema and migration tracking tables.
* **[Key Migration Governance](./key-migration-governance.md):** Standards for modern server key preference (`SUPABASE_SECRET_KEY` over legacy `SUPABASE_SERVICE_ROLE_KEY`) and secret rotation policies.
* **[Staff Lifecycle Design](./staff-lifecycle-design.md):** Governance design for staff provisioning, role modification, emergency offboarding, and audit attribution.
* **[Password Recovery Setup](./password-recovery-setup.md):** Local Mailpit verification, hosted Auth URL/template requirements, PKCE fallback, and recovery-session security boundaries.
* **[Staging Auth Verification](./staging-auth-verification.md):** Controlled authentication and authorization verification runbook.
* **[Manual Apply Guide](./manual-apply-guide.md):** Historical manual migration reference (the staging reconciliation runbook outranks this for existing projects).

---

## ⚠️ Operational Constraints

1. **Target Environment Only:** These migrations are governed for the active `capstone-admin-cms-staging-v2-2026` Supabase project. The historical `capstone-admin-cms-staging-2026` project is paused and is not a routine target.
2. **Never Apply to Recovery/Demo Projects:** Under no circumstances should these files be executed on the Prototype recovery project or any previous demo baseline.
3. **Governed Hosted Changes:** Any hosted migration application or migration-history repair requires the 7-gate process and explicit project-owner authorization. `supabase migration repair` is not routine for active staging-v2.
4. **No Duda Connection:** The public Duda showcase site remains disconnected from staging buckets and live feeds.
5. **No Real Personal Data:** Real participant, supervisor, or stakeholder personal data must never be loaded into staging.

---

## Selected Migration Inventory (46 Migrations Total)

The executable files under `migrations/` and the exact manifest enforced by
`apps/admin-cms/src/deployment/hostedDeploymentReadiness.ts` are authoritative. The entries below
highlight major milestones rather than replacing that complete manifest.

* **[20260601035138_staging_schema.sql](./migrations/20260601035138_staging_schema.sql):** Creates core relational tables (`programs`, `disciplines`, `industry_categories`, `admin_users`, `user_roles`, `import_batches`, `projects`, `project_disciplines`, `project_industry_categories`, `media_assets`, `validation_flags`, `approval_records`, `published_snapshots`), check constraints, indexes, and `updated_at` triggers.
* **[20260601035139_staging_rls_policies.sql](./migrations/20260601035139_staging_rls_policies.sql):** Enables Row-Level Security (RLS) across all tables with restrictive defaults.
* **[20260715102956_admin_auth_identity.sql](./migrations/20260715102956_admin_auth_identity.sql):** Adds `auth_user_id UUID` column to `admin_users` linked to `auth.users(id)`.
* **[20260719003407_explicit_data_api_grants.sql](./migrations/20260719003407_explicit_data_api_grants.sql):** Establishes explicit least-privilege Data API grants (`anon` denied, `authenticated` read-only lookups, `service_role` full administrative CRUD).
* **[20260719165118_initial_admin_bootstrap.sql](./migrations/20260719165118_initial_admin_bootstrap.sql):** Registers transactional PL/pgSQL function `public.bootstrap_initial_admin(uuid, text, text)` with advisory transaction locking.
* **[20260719165119_fix_initial_admin_bootstrap_runtime.sql](./migrations/20260719165119_fix_initial_admin_bootstrap_runtime.sql):** Replaces `pg_catalog.trim` with PostgreSQL standard `pg_catalog.btrim` as the corrective runtime fix for initial administrator linkage.
* **[20260803174000_harden_function_execute_defaults.sql](./migrations/20260803174000_harden_function_execute_defaults.sql):** Establishes global postgres-owned function default privilege revokes and conditionally revokes execution on the optional hosted RLS helper.
* **[20260803180000_transactional_review_actions.sql](./migrations/20260803180000_transactional_review_actions.sql):** Establishes atomic `public.perform_project_review_action` PostgreSQL RPC function for transaction-backed project review status updates and approval audit logging.
* **[20260808170000_transactional_project_metadata_update.sql](./migrations/20260808170000_transactional_project_metadata_update.sql):** Establishes the atomic, service-role-only `public.update_project_metadata` transaction for metadata scalar and mapping writes.
* **... Migrations 0010 through 0020 ...**
* **[20260813002154_project_metadata_audit_history.sql](./migrations/20260813002154_project_metadata_audit_history.sql):** Introduces granular project metadata change history tracking in `approval_records`.
* **[20260813120000_staff_identity_provisioning.sql](./migrations/20260813120000_staff_identity_provisioning.sql):** Establishes the `staff_provisioning_requests` state machine and the service-role-only `reserve_staff_provisioning`, `bind_staff_provisioning_identity`, `finalize_staff_provisioning`, `activate_staff_provisioning` and `fail_staff_provisioning` functions that converge Supabase Auth and PostgreSQL for controlled staff identity provisioning, including proven-eligibility compensation and the canonical staff role order.
* **[20260813180000_participant_preview_email_notifications.sql](./migrations/20260813180000_participant_preview_email_notifications.sql):** Adds the authoritative `projects.participant_contact_email` column (normalized, bounded, nullable), redefines `stage_browser_import_metadata` so the canonical import path persists it, and establishes the `participant_preview_notifications` delivery ledger with the service-role-only `reserve_participant_preview_notification`, `generate_participant_preview_with_notification`, `begin_participant_preview_notification_transport`, `finalize_participant_preview_notification` and `reconcile_participant_preview_notification` functions. The ledger holds no preview credential, secure URL or message body; delivery is fenced by a hashed two-minute execution lease and represents ambiguous outcomes as `delivery_unknown`.
* **[20260813190000_participant_preview_reminder_schedules.sql](./migrations/20260813190000_participant_preview_reminder_schedules.sql):** Adds durable exact-preview reminder schedules, evolves the notification ledger to support one reminder notification per schedule while preserving one initial notification per preview, and provides service-role-only schedule, cancel, and bounded `FOR UPDATE SKIP LOCKED` due-claim functions. Claim and pre-transport checks suppress confirmed, correction-blocked, revoked, expired, superseded, contact-changed, and otherwise ineligible previews. Schedule and notification rows contain no preview token, URL, or rendered body. *(Production scheduler/provider activation pending.)*
* **[20260814090000_accessible_full_text_gate.sql](./migrations/20260814090000_accessible_full_text_gate.sql):** Enforces accessible poster full text (`projects.poster_text_public`) and poster accessibility text (`projects.accessibility_text_public`) across metadata updates, import review submission, approval, and publication readiness gates.
* **[20260814140000_snapshot_image_alt_text.sql](./migrations/20260814140000_snapshot_image_alt_text.sql):** Adds authoritative staff-authored alt text (`media_assets.alt_text_public`) for snapshot images, establishes `public.update_snapshot_image_alt_text`, and enforces snapshot alt text across media staging, review submission, approval, participant preview generation, and publication readiness.
* **[20260816144917_staging_uat_direct_account_finalization.sql](./migrations/20260816144917_staging_uat_direct_account_finalization.sql):** Adds the service-role-only transactional `finalize_and_activate_staff_provisioning` RPC for direct staging UAT identities. It independently rejects Administrator roles, re-proves exact Auth email and ownership marker, and atomically creates the staff profile, assigns Reviewer/Editor roles, and activates the lifecycle.
* **[20260817090000_private_media_approval_gate.sql](./migrations/20260817090000_private_media_approval_gate.sql):** Requires one exact, internally consistent private poster image and PDF before project approval while preserving request-change and archive behavior.
* **[20260819214431_password_recovery_session_provenance.sql](./migrations/20260819214431_password_recovery_session_provenance.sql):** Adds the locked `password_recovery_sessions` ledger, service-role registration RPC, and authenticated no-argument lookup used to keep recovery sessions out of Admin until the Auth session ends. The lookup resolves the verified JWT `session_id` against `auth.sessions` first, so a deleted Auth session returns `INVALID_CONTEXT` and only a live session owned by `auth.uid()` can report `NOT_REGISTERED`.
* **[20260820120000_assistive_validation_persistence.sql](./migrations/20260820120000_assistive_validation_persistence.sql):** Adds durable assistive-validation run/finding persistence with restrictive access and service-role coordination.
* **[20260820160000_assistive_validation_job_coordination.sql](./migrations/20260820160000_assistive_validation_job_coordination.sql):** Adds bounded assistive-validation job reservation, ownership, execution, and recovery coordination.
* **[20260821090000_assistive_validation_staff_inspection.sql](./migrations/20260821090000_assistive_validation_staff_inspection.sql):** Adds safe staff inspection and disposition functions for persisted assistive-validation evidence.
* **[20260821140000_assistive_duplicate_shortlist.sql](./migrations/20260821140000_assistive_duplicate_shortlist.sql):** Adds deterministic duplicate-candidate shortlist evidence and bounded staff inspection support.
* **[20260824180000_public_feed_deployment_ledger.sql](./migrations/20260824180000_public_feed_deployment_ledger.sql):** Adds immutable exact-byte public-feed versions and ordered membership, the explicit deployment head, globally exclusive operation ledger, opaque rollback preparations, immutable operation events, RLS, and service-role read grants without migration-time Storage I/O.
* **[20260824183000_public_feed_writer_protocol.sql](./migrations/20260824183000_public_feed_writer_protocol.sql):** Adds the service-role-only token/epoch-fenced canonical writer protocol for activation, publication, removal, reconciliation, rollback, and explicit forward recovery; adds `public.get_project_reconciliation_readiness` as a separate published-target deployment authority that re-derives participant confirmation, gallery position, and per-image alt-text evidence and is proved again at the final durable pre-write boundary; legacy canonical writer RPCs fail closed.
* **[20260825030000_public_feed_taxonomy_operation_guard.sql](./migrations/20260825030000_public_feed_taxonomy_operation_guard.sql):** Freezes referenced discipline and industry-category lookup identities during active public-feed operations with narrow `UPDATE`/`DELETE` triggers, while leaving unrelated and newly inserted lookup rows available.
* **[20260826090000_public_feed_activation_authority_guard.sql](./migrations/20260826090000_public_feed_activation_authority_guard.sql):** Uses durable global generation authority plus project/discipline write fences to keep a bound activation candidate authoritative through its first durable write or observation boundary under PostgreSQL MVCC, including recovery from `PREPARED`, without globally serializing unrelated draft projects.
