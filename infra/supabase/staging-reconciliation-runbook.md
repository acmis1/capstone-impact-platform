# Staging Database Migration Reconciliation Runbook

> [!CAUTION]
> **STRICT GOVERNANCE DIRECTIVE**: Direct execution of `supabase db push` or `supabase db reset` against a hosted shared-staging project is **STRICTLY PROHIBITED** until the 7-gate reconciliation procedure is fully completed and explicitly authorized by the project owner.

## Historical Background & Context

1. Database DDL statements were historically applied manually to the hosted Supabase instance using the dashboard SQL Editor.
2. Local repository migration filenames were subsequently converted from legacy numbered prefixes (`0001_`–`0006_`) to standard ISO timestamp format (`20260601035138_` through `20260719165119_`).
3. As a result, the migration tracking history (`supabase_migrations.schema_migrations`) in the hosted project is unknown until inspected. Running `supabase db push` without reconciliation would attempt to re-execute timestamped DDL files against existing database tables, causing runtime schema conflicts (`relation already exists`).
4. Executing `supabase migration repair` modifies **only the tracking history table** (`supabase_migrations.schema_migrations`); it does **not** alter actual database tables, columns, constraints, or security policies.
5. `supabase migration repair` is a conditional option that must be evaluated step by step—it is **not** a predetermined outcome.

---

## Read-Only Reconciliation Gates (Gates 1–4)

All commands in this section perform read-only inspection and identity validation.

### Gate 1: Recovery Readiness
Verify local CLI, authentication, and project target identity:
```bash
node --version
npm --version
supabase --version
```
Ensure local git working tree is clean and `main` branch is up to date before proceeding.

### Gate 2: Read-Only Target Identity & Schema Inventory
Connect to the target staging environment in read-only mode to verify host identity and list existing tables:
```bash
# Verify target identity configuration
echo $CAPSTONE_RUNTIME_ENV
echo $CAPSTONE_EXPECTED_SUPABASE_HOST
```
Inspect existing database tables and structure in the hosted database using safe read-only queries or dashboard inspection.

### Gate 3: Read-Only Migration History Inventory
Query the remote migration tracking table to inventory recorded migrations:
```bash
# Read-only check of hosted migration tracking table
# (Inspect supabase_migrations.schema_migrations via read-only SQL query or CLI)
```
Compare the list of remote migration version strings against local timestamped files in `infra/supabase/migrations/`:
- `20260601035138_staging_schema.sql`
- `20260601035139_staging_rls_policies.sql`
- `20260715102956_admin_auth_identity.sql`
- `20260719003407_explicit_data_api_grants.sql`
- `20260719165118_initial_admin_bootstrap.sql`
- `20260719165119_fix_initial_admin_bootstrap_runtime.sql`

### Gate 4: Exact Repository-to-Hosted Schema Comparison
Perform a thorough comparison between the local migration DDL definitions and the hosted database schema:
1. Verify all 13 core tables exist (`programs`, `disciplines`, `industry_categories`, `admin_users`, `user_roles`, `import_batches`, `projects`, `project_disciplines`, `project_industry_categories`, `media_assets`, `validation_flags`, `approval_records`, `published_snapshots`).
2. Verify Row Level Security (RLS) is enabled on all 13 tables.
3. Verify table-level Data API grants (`anon` 0, `authenticated` lookup SELECT only, `service_role` full CRUD).
4. Verify function execution grants for `bootstrap_initial_admin`.

---

## Decision Gate (Gate 5)

### Gate 5: Decision Matrix
Evaluate findings from Gates 1–4 and select the required reconciliation path:
- **Path A (Repair)**: Hosted schema matches repository DDL exactly, but migration history table lists legacy numbers or is empty. Proceed to Gate 6 for migration history repair.
- **Path B (Baseline)**: Hosted database contains baseline schema; mark initial migration as applied.
- **Path C (Drift Resolution)**: Schema drift or column mismatch detected. Defer repair and investigate missing DDL statements.
- **Path D (Abort)**: Unresolvable discrepancy or missing authorization. Abort reconciliation.

---

## Separately Authorized Mutating Gates (Gates 6–7)

> [!WARNING]
> **DO NOT RUN WITHOUT PROJECT-OWNER APPROVAL**
> The commands below modify database migration tracking state or apply database mutations. They require explicit project-owner authorization.

### Gate 6: Separately Authorized Mutation

#### Option A: Migration History Repair (Conditional)
> **DO NOT RUN WITHOUT PROJECT-OWNER APPROVAL**
If Path A was selected in Gate 5, mark timestamped migrations as applied in tracking history:
```bash
# DO NOT RUN WITHOUT PROJECT-OWNER APPROVAL
# Example repair command structure (Requires explicit confirmation & authorization):
# supabase migration repair --status applied <migration_timestamp> --workdir infra
```

#### Option B: Schema Migration Push (Conditional)
> **DO NOT RUN WITHOUT PROJECT-OWNER APPROVAL**
If new timestamped migrations need to be applied after tracking history is aligned:
```bash
# DO NOT RUN WITHOUT PROJECT-OWNER APPROVAL
# supabase db push --workdir infra
```

### Gate 7: Post-Change Verification and Incident Response
1. Execute read-only verification suite:
   ```bash
   npm run check:admin-staging-auth
   ```
2. Verify application health route:
   ```bash
   curl -s https://<staging-app-domain>/api/health
   ```
3. If any failure or unexpected schema drift is observed, execute rollback procedures immediately and notify project owners.
