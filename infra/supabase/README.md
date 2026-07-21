# Staging Supabase Migrations (`infra/supabase`)

This directory contains the version-controlled database schema migrations and policy definitions for the Capstone Admin/CMS staging environment (`capstone-admin-cms-staging-2026`).

---

## ⚠️ Current Environment & Staging Status

> [!NOTE]
> * **Applied Status:** Migrations `0001` through `0006` have been manually applied and verified in the isolated staging project (`capstone-admin-cms-staging-2026` in Singapore).
> * **Corrective Fix:** Migration `0006` corrected the initial administrator bootstrap runtime by replacing `pg_catalog.trim` with PostgreSQL standard `pg_catalog.btrim`.
> * **Identity Linkage:** Initial administrator linkage has already been completed (`CREATED`) and verified (`READY_FOR_MANUAL_LOGIN_TEST`).
> * **Do Not Rerun:** Do not rerun the migration sequence or initial bootstrap merely because these files exist.
> * **Pending Scope:** Broader multi-role RLS matrices, reviewer/editor UAT, CSRF mutation tests, and production deployment remain pending. Standard Supabase CLI migration delivery is not currently implemented.

---

## ⚠️ Operational Constraints

1. **Target Environment Only:** These migrations are designed **exclusively** for the isolated `capstone-admin-cms-staging-2026` Supabase project.
2. **Never Apply to Recovery/Demo Projects:** Under no circumstances should these files be executed on the Prototype recovery project or any previous demo baseline.
3. **Manual Application:** In the current manual workflow, migrations are applied in order through the Supabase Dashboard **SQL Editor**.
4. **No Duda Connection:** The public Duda showcase site remains disconnected from staging buckets and live feeds.
5. **No Real Personal Data:** Real student, supervisor, or stakeholder personal data must never be loaded into staging.

---

## Migration Inventory

* **[0001_staging_schema.sql](./migrations/0001_staging_schema.sql):** Creates core relational tables (`programs`, `disciplines`, `industry_categories`, `admin_users`, `user_roles`, `import_batches`, `projects`, `project_disciplines`, `project_industry_categories`, `media_assets`, `validation_flags`, `approval_records`, `published_snapshots`), check constraints, indexes, and `updated_at` triggers.
* **[0002_staging_rls_policies.sql](./migrations/0002_staging_rls_policies.sql):** Enables Row-Level Security (RLS) across all tables with restrictive defaults.
* **[0003_admin_auth_identity.sql](./migrations/0003_admin_auth_identity.sql):** Adds `auth_user_id UUID` column to `admin_users` linked to `auth.users(id)`.
* **[0004_explicit_data_api_grants.sql](./migrations/0004_explicit_data_api_grants.sql):** Establishes explicit least-privilege Data API grants (`anon` denied, `authenticated` read-only lookups, `service_role` full administrative CRUD).
* **[0005_initial_admin_bootstrap.sql](./migrations/0005_initial_admin_bootstrap.sql):** Registers transactional PL/pgSQL function `public.bootstrap_initial_admin(uuid, text, text)` with advisory transaction locking.
* **[0006_fix_initial_admin_bootstrap_runtime.sql](./migrations/0006_fix_initial_admin_bootstrap_runtime.sql):** Replaces `pg_catalog.trim` with PostgreSQL standard `pg_catalog.btrim` as the corrective runtime fix for initial administrator linkage.
