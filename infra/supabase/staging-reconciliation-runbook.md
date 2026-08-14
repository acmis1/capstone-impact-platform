# Staging Database Migration Reconciliation Runbook

> [!CAUTION]
> **STRICT GOVERNANCE DIRECTIVE**: Direct execution of `supabase db push`, `supabase db reset`, `supabase migration repair`, or manual schema mutations against a hosted shared-staging project is **STRICTLY PROHIBITED** until the 7-gate reconciliation procedure is fully completed and explicitly authorized by the project owner.

---

## 1. Context & Governance Baseline

1. **Historical Staging Origin**: Initial database DDL statements (`0001` through `0006`) were applied manually to the isolated hosted Supabase instance (`capstone-admin-cms-staging-2026`) using the dashboard SQL Editor.
2. **Migration Tracking State**: Because early migrations were manually applied, remote migration tracking (`supabase_migrations.schema_migrations`) may be unpopulated or contain legacy version numbers. Running `supabase db push` without prior reconciliation risks re-executing DDL against existing tables (`relation already exists`).
3. **Repository State vs Hosted State**: Current repository `main` contains **exactly 26 migrations** defining 22 tables, 3 storage buckets, and 28 RPC functions. Hosted staging is documented as having only early baseline migrations (`0001`–`0006`) applied. Migrations `0007` through `0026` are repository/local-only until reconciled.
4. **Scope of Migration Repair**: `supabase migration repair` modifies **only the tracking history table** (`supabase_migrations.schema_migrations`). It does not alter database tables, columns, constraints, or RPC functions.

---

## 2. Expected Repository State (26 Migrations)

### A. Authoritative Migration Inventory

| # | Migration File | Description |
| :--- | :--- | :--- |
| 1 | `20260601035138_staging_schema.sql` | 13 core tables, foreign keys, indexes, and updated_at triggers |
| 2 | `20260601035139_staging_rls_policies.sql` | Restrictive Row Level Security policies on 13 core tables |
| 3 | `20260715102956_admin_auth_identity.sql` | Links `admin_users.auth_user_id` to `auth.users(id)` |
| 4 | `20260719003407_explicit_data_api_grants.sql` | Least-privilege Data API grants (`anon` denied, `authenticated` lookup SELECT only, `service_role` full CRUD) |
| 5 | `20260719165118_initial_admin_bootstrap.sql` | Transactional `bootstrap_initial_admin` function |
| 6 | `20260719165119_fix_initial_admin_bootstrap_runtime.sql` | Corrects bootstrap runtime function using `pg_catalog.btrim` |
| 7 | `20260803174000_harden_function_execute_defaults.sql` | Hardens default function execution privileges |
| 8 | `20260803180000_transactional_review_actions.sql` | Atomic `perform_project_review_action` RPC and approval records audit |
| 9 | `20260808170000_transactional_project_metadata_update.sql` | Atomic `update_project_metadata` RPC for scalar and relationship writes |
| 10 | `20260810090000_atomic_browser_import_metadata_stage.sql` | `stage_browser_import_metadata` RPC and `browser_import_commits` ledger |
| 11 | `20260810120000_atomic_browser_import_media_stage.sql` | `finalize_browser_import_media_stage` RPC and `browser_import_media_commits` ledger |
| 12 | `20260810150000_atomic_import_batch_review_submit.sql` | `submit_import_projects_for_review` RPC with pre-mutation validation |
| 13 | `20260810180000_participant_preview_links.sql` | `participant_previews` & `participant_preview_tokens` tables and preview generation RPCs |
| 14 | `20260811090000_participant_preview_confirmations.sql` | `participant_preview_confirmations` table and confirmation RPCs |
| 15 | `20260811120000_participant_preview_correction_requests.sql` | `participant_preview_correction_requests` table and correction request RPC |
| 16 | `20260811130000_participant_preview_correction_resolution.sql` | `resolve_participant_preview_correction_request` RPC and preview reissue logic |
| 17 | `20260811150000_publication_readiness_gate.sql` | `get_project_publication_readiness` RPC and validation gates |
| 18 | `20260811160000_approval_edit_gate.sql` | Approved/published state edit locks in `update_project_metadata` |
| 19 | `20260812120000_controlled_publication_execution.sql` | `execute_controlled_publication` RPC and snapshot staging |
| 20 | `20260812150000_controlled_public_removal.sql` | `execute_controlled_public_removal` RPC and archive status gates |
| 21 | `20260813002154_project_metadata_audit_history.sql` | Detailed metadata diff audit logging in `approval_records.event_details` |
| 22 | `20260813120000_staff_identity_provisioning.sql` | `staff_provisioning_requests` table and staff provisioning state machine RPCs |
| 23 | `20260813180000_participant_preview_email_notifications.sql` | `projects.participant_contact_email` column, `participant_preview_notifications` ledger, and notification RPCs |
| 24 | `20260813190000_participant_preview_reminder_schedules.sql` | `participant_preview_reminder_schedules` table and reminder scheduling RPCs |
| 25 | `20260814090000_accessible_full_text_gate.sql` | Mandatory poster full text (`poster_text_public`) and accessibility text (`accessibility_text_public`) gates |
| 26 | `20260814140000_snapshot_image_alt_text.sql` | Mandatory snapshot image alt text (`media_assets.alt_text_public`) column and gates |

### B. Expected Tables (22 Total)
- **Core Relational (13)**: `programs`, `disciplines`, `industry_categories`, `admin_users`, `user_roles`, `import_batches`, `projects`, `project_disciplines`, `project_industry_categories`, `media_assets`, `validation_flags`, `approval_records`, `published_snapshots`
- **Import Commit Ledgers (2)**: `browser_import_commits`, `browser_import_media_commits`
- **Participant Preview & Correction (4)**: `participant_previews`, `participant_preview_tokens`, `participant_preview_confirmations`, `participant_preview_correction_requests`
- **Staff Lifecycle (1)**: `staff_provisioning_requests`
- **Notification & Reminder Ledgers (2)**: `participant_preview_notifications`, `participant_preview_reminder_schedules`

### C. Expected Storage Buckets (3 Total)
- `project-drafts-private`: Private draft uploads and participant package artifacts.
- `project-public-assets`: Approved public poster and snapshot image assets.
- `public-feeds`: Schema-validated public JSON showcase feed (`capstones-latest.json`).

### D. Key Column & Constraint Requirements
- `projects.participant_contact_email`: Normalized nullable email address (Migration 0023).
- `projects.poster_text_public`: Required, non-blank after trim, <= 20000 chars (Migration 0025).
- `projects.accessibility_text_public`: Required, non-blank after trim, <= 2000 chars (Migration 0025).
- `media_assets.alt_text_public`: Required for snapshot images, <= 2000 chars (Migration 0026).

---

## 3. Read-Only Reconciliation Gates (Gates 1–4)

All commands in Gates 1–4 perform read-only inspection. They make zero database or storage changes.

### Gate 1: Toolchain & Working Tree Verification
Verify pinned versions and clean working tree:
```bash
node --version       # Expected: >= 24.14.1 < 25
npm --version        # Expected: >= 11.11.0 < 12
git status --short --untracked-files=no
git rev-parse HEAD   # Verify against origin/main
```

### Gate 2: Read-Only Target Identity & Deployment Readiness
Execute the automated read-only deployment readiness checker:
```bash
npm run check:admin-deployment-readiness
```

Verify the output report:
- `TARGET_IDENTITY_MATCH = YES`
- `MIGRATION_HISTORY_READABLE = YES/NO`
- `REPOSITORY_MIGRATIONS = 26`
- `HOSTED_RECORDED_MIGRATIONS = <count or UNKNOWN>`
- `SCHEMA_BASELINE = MATCH / INCOMPLETE / DRIFT / UNKNOWN`
- `REQUIRED_RPC_SET = PRESENT / INCOMPLETE`
- `REQUIRED_TABLE_SET = PRESENT / INCOMPLETE`
- `REQUIRED_STORAGE_BUCKETS = PRESENT / INCOMPLETE`
- `AUTH_FOUNDATION = READY / INCOMPLETE`

### Gate 3: Read-Only Migration Tracking Audit
Inspect `supabase_migrations.schema_migrations` to determine recorded migration versions:
```sql
-- Read-only SQL query via Supabase Dashboard SQL Editor or CLI
SELECT version, inserted_at
  FROM supabase_migrations.schema_migrations
 ORDER BY version ASC;
```
Record exact count and missing timestamps against the 26 repository migrations.

### Gate 4: Hosted vs Repository Schema Evidence
Perform read-only inspection of hosted tables, columns, and RPC functions:
1. Verify presence of 13 core tables vs 9 post-0006 extended tables.
2. Verify presence of `alt_text_public` column in `media_assets`.
3. Verify presence of `poster_text_public` and `accessibility_text_public` in `projects`.
4. Verify presence of core RPCs (`update_project_metadata`, `submit_import_projects_for_review`, `perform_project_review_action`, `get_project_publication_readiness`, `update_snapshot_image_alt_text`).
5. Verify Row Level Security is active across all existing tables.

---

## 4. Decision Gate (Gate 5)

Evaluate empirical evidence from Gates 1–4 to determine the required path:

```mermaid
flowchart TD
    G[Gates 1-4 Evidence] --> C{Schema & History State}
    C -->|All 26 migrations applied & history matches| PA[Path A: Ready for Deployment Decision]
    C -->|0001-0006 applied, 0007-0026 pending| PB[Path B: Phased Reconciliation & Push]
    C -->|Unexpected column/table drift| PC[Path C: Drift Resolution Required]
    C -->|Target mismatch or unauthorized| PD[Path D: Stop & Abort]
```

- **Path A (Full Match / Ready)**: All 26 migrations are recorded and all 22 tables / 28 RPCs are verified. Proceed directly to Gate 7 verification.
- **Path B (Phased Reconciliation / Staging Standard)**: Hosted staging contains baseline migrations 0001–0006; migration tracking history needs repair for 0001–0006, followed by separately authorized application of forward migrations 0007–0026. Proceed to Gate 6.
- **Path C (Drift Detected)**: Unrecognized columns, conflicting constraint names, or manual schema changes detected. STOP. Document drift and formulate an explicit resolution plan.
- **Path D (Abort)**: Target identity mismatch or lack of operator authorization. STOP immediately.

---

## 5. Separately Authorized Mutating Gates (Gates 6–7)

> [!WARNING]
> **EXPLICIT PROJECT-OWNER APPROVAL REQUIRED**
> The commands below modify database tables or migration tracking records. They must never be executed autonomously.

### Gate 6: Separately Authorized Reconciliation & Migration

#### Step 6.1: Repair Tracking History for Existing Baseline (Conditional)
If hosted database already has early migrations 0001–0006 applied manually:
```bash
# REQUIRES EXPLICIT AUTHORIZATION
# Mark migrations 0001-0006 as applied in tracking table
supabase migration repair --status applied 20260601035138 --workdir infra
supabase migration repair --status applied 20260601035139 --workdir infra
supabase migration repair --status applied 20260715102956 --workdir infra
supabase migration repair --status applied 20260719003407 --workdir infra
supabase migration repair --status applied 20260719165118 --workdir infra
supabase migration repair --status applied 20260719165119 --workdir infra
```

#### Step 6.2: Apply Forward Migrations (0007–0026) (Conditional)
Once baseline tracking is aligned, apply forward migrations in deterministic sequence:
```bash
# REQUIRES EXPLICIT AUTHORIZATION
supabase db push --workdir infra
```

### Gate 7: Post-Reconciliation Verification

1. Re-run read-only deployment readiness checker:
   ```bash
   npm run check:admin-deployment-readiness
   ```
   *Required result: `DEPLOYMENT_CLASSIFICATION = READY_FOR_MUTATION_DECISION` (or deployment).*

2. Verify authentication linkage:
   ```bash
   npm run check:admin-auth
   ```
   *Required result: `classification=READY_FOR_MANUAL_LOGIN_TEST`.*

3. Verify application health route:
   ```bash
   curl -s https://<staging-domain>/api/health
   ```
   *Required result: `status: "ok"`, `stagingOnly: true`.*

---

## 6. Incident Response & Contained Error Handling

If any unexpected error occurs during reconciliation:
1. **Stop Immediately**: Cease all CLI execution. Do not retry `db push` or `migration repair`.
2. **Preserve Logs Privately**: Capture terminal output without disclosing secret keys or connection strings.
3. **Check Application Health**: Probe `/api/health` to assess operational availability.
4. **Isolate Scope**: Determine whether discrepancies are confined to `schema_migrations` or affect table data.
5. **Report to Project Owner**: Provide empirical output classification for remediation approval.
