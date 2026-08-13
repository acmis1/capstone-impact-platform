# Staging Supabase Migrations (`infra/supabase`)

This directory contains the version-controlled database schema migrations, policy definitions, local development setup scripts, and operational governance runbooks for the Capstone Admin/CMS platform.

---

## ⚠️ Current Environment & Staging Status

> [!NOTE]
> * **Local Development:** Reproducible local Supabase development is verified on Windows with Docker Desktop via CLI 2.109.1. Local migrations (`0001` through `0009`) replay cleanly and pass automated verifiers. macOS and Linux remain unverified; independent human verification remains pending. Local development requires **no** Supabase cloud account or organization membership.
> * **Hosted Staging Status:** Migrations `0001` through `0006` were manually applied to the isolated staging project (`capstone-admin-cms-staging-2026`). Local migration replay success is distinct from unknown hosted CLI migration history, which remains unverified until the 7-gate reconciliation runbook is executed.
> * **Corrective Fix:** Migration `0006` corrected the initial administrator bootstrap runtime by replacing `pg_catalog.trim` with PostgreSQL standard `pg_catalog.btrim`.
> * **Default Execution Hardening:** Migration `0007` (`20260803174000_harden_function_execute_defaults.sql`) establishes global postgres-owned function default privilege revokes and conditionally revokes execution on the optional hosted RLS helper. *(Committed in repository; local/repository-only; not yet applied to hosted staging.)*
> * **Transactional Review Actions:** Migration `0008` (`20260803180000_transactional_review_actions.sql`) establishes atomic `public.perform_project_review_action` PostgreSQL RPC function for transaction-backed project review status updates and approval audit logging. *(Committed in repository; local/repository-only; not yet applied to hosted staging.)*
> * **Transactional Metadata Update:** Migration `0009` (`20260808170000_transactional_project_metadata_update.sql`) establishes the one-transaction, service-role-only `public.update_project_metadata` RPC for scalar metadata and join-table writes. *(Repository/local-only; not applied to hosted staging.)*
> * **Project Metadata Audit Trail:** Migration `0021` (`20260813002154_project_metadata_audit_history.sql`) introduces the project metadata audit trail directly into `approval_records`. *(Repository/local-only; not applied to hosted staging.)*
> * **Identity Linkage:** Initial administrator linkage was verified in isolated staging (`READY_FOR_MANUAL_LOGIN_TEST`).
> * **Do Not Rerun:** Do not rerun the migration sequence or initial bootstrap merely because these files exist.
> * **Pending Scope:** Hosted migration reconciliation, hosted staff lifecycle provisioning, reviewer/editor UAT, and production deployment remain pending.

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
* **[Staging Auth Verification](./staging-auth-verification.md):** Controlled authentication and authorization verification runbook.
* **[Manual Apply Guide](./manual-apply-guide.md):** Historical manual migration reference (the staging reconciliation runbook outranks this for existing projects).

---

## ⚠️ Operational Constraints

1. **Target Environment Only:** These migrations are designed **exclusively** for the isolated `capstone-admin-cms-staging-2026` Supabase project.
2. **Never Apply to Recovery/Demo Projects:** Under no circumstances should these files be executed on the Prototype recovery project or any previous demo baseline.
3. **Manual Application:** In the current manual workflow, migrations are applied in order through the Supabase Dashboard **SQL Editor** or CLI migration repair.
4. **No Duda Connection:** The public Duda showcase site remains disconnected from staging buckets and live feeds.
5. **No Real Personal Data:** Real participant, supervisor, or stakeholder personal data must never be loaded into staging.

---

## Migration Inventory (21 Migrations)

* **[20260601035138_staging_schema.sql](./migrations/20260601035138_staging_schema.sql):** Creates core relational tables (`programs`, `disciplines`, `industry_categories`, `admin_users`, `user_roles`, `import_batches`, `projects`, `project_disciplines`, `project_industry_categories`, `media_assets`, `validation_flags`, `approval_records`, `published_snapshots`), check constraints, indexes, and `updated_at` triggers.
* **[20260601035139_staging_rls_policies.sql](./migrations/20260601035139_staging_rls_policies.sql):** Enables Row-Level Security (RLS) across all tables with restrictive defaults.
* **[20260715102956_admin_auth_identity.sql](./migrations/20260715102956_admin_auth_identity.sql):** Adds `auth_user_id UUID` column to `admin_users` linked to `auth.users(id)`.
* **[20260719003407_explicit_data_api_grants.sql](./migrations/20260719003407_explicit_data_api_grants.sql):** Establishes explicit least-privilege Data API grants (`anon` denied, `authenticated` read-only lookups, `service_role` full administrative CRUD).
* **[20260719165118_initial_admin_bootstrap.sql](./migrations/20260719165118_initial_admin_bootstrap.sql):** Registers transactional PL/pgSQL function `public.bootstrap_initial_admin(uuid, text, text)` with advisory transaction locking.
* **[20260719165119_fix_initial_admin_bootstrap_runtime.sql](./migrations/20260719165119_fix_initial_admin_bootstrap_runtime.sql):** Replaces `pg_catalog.trim` with PostgreSQL standard `pg_catalog.btrim` as the corrective runtime fix for initial administrator linkage.
* **[20260803174000_harden_function_execute_defaults.sql](./migrations/20260803174000_harden_function_execute_defaults.sql):** Establishes global postgres-owned function default privilege revokes and conditionally revokes execution on the optional hosted RLS helper. *(Committed in repository; local/repository-only; not yet applied to hosted staging.)*
* **[20260803180000_transactional_review_actions.sql](./migrations/20260803180000_transactional_review_actions.sql):** Establishes atomic `public.perform_project_review_action` PostgreSQL RPC function for transaction-backed project review status updates and approval audit logging. *(Committed in repository; local/repository-only; not yet applied to hosted staging.)*
* **[20260808170000_transactional_project_metadata_update.sql](./migrations/20260808170000_transactional_project_metadata_update.sql):** Establishes the atomic, service-role-only `public.update_project_metadata` transaction for metadata scalar and mapping writes. *(Repository/local-only; not applied to hosted staging.)*
* **... Migrations 0010 through 0020 ...**
* **[20260813002154_project_metadata_audit_history.sql](./migrations/20260813002154_project_metadata_audit_history.sql):** Introduces granular project metadata change history tracking in `approval_records`. *(Repository/local-only; not applied to hosted staging.)*
