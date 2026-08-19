# Admin/CMS Hosted Staging Deployment Guide

This document defines the deployment contract, service architecture, environment configuration, and synthetic stakeholder verification workflow for deploying the Admin/CMS (`apps/admin-cms`) to a hosted staging environment.

---

## 1. Architectural Separation & Hosting Strategy

The Capstone platform enforces strict architectural and operational isolation between the feasibility Prototype and the production-oriented Admin/CMS application:

| Attribute | Prototype Service | Active Admin/CMS Staging | Paused Admin/CMS Fallback |
| :--- | :--- | :--- | :--- |
| **Directory** | `Prototype/` | `apps/admin-cms/` | `apps/admin-cms/` (historical) |
| **Service Role** | Historical feasibility & public Duda presentation support | Authenticated school administration & CMS source of truth | Temporary rollback & historical evidence fallback |
| **Supabase Instance** | `capstone-prototype-recovery-2026` (`bpnmrgmzgbisvykppuwp`) | `capstone-admin-cms-staging-v2-2026` (`sqkpceeltukbzxpsvinb`) | `capstone-admin-cms-staging-2026` (`fewcbklmbgzglfgedtvt`) |
| **Instance Status** | Active / Separate (Never touch) | **ACTIVE_HEALTHY** (Active Target) | **PAUSED / INACTIVE** (Do not modify) |
| **Region** | `ap-southeast-1` | `ap-southeast-1` | `ap-southeast-1` |
| **Hosting Service** | Existing Render static/web service | **Separate** Render/Cloud Web Service | — |
| **Database State** | Prohibited from mutation | Clean 26-migration schema (0001–0026) | Historical manually evolved baseline; migration history untracked |

> [!IMPORTANT]
> The existing Render service configured for `Prototype/` must **NEVER** be repurposed or pointed to `apps/admin-cms`. The Admin/CMS requires an independent web service with its own environment variables and deployment pipeline. Furthermore, the Prototype Supabase project (`capstone-prototype-recovery-2026`) is completely isolated and must never be targeted by Admin/CMS operations.

---

## 2. Toolchain & Build Contract

### A. Engine Requirements
- **Node.js**: `>= 24.14.1 < 25` (Pinned via `.nvmrc` to `24.14.1`)
- **npm**: `>= 11.11.0 < 12` (Declared in root `packageManager` as `npm@11.11.0`)

### B. Deployment Commands
- **Root Directory**: Repository root (`/`)
- **Build Working Directory**: `apps/admin-cms` (or repository root with workspace targeting)
- **Install Command**: `npm ci`
- **Build Command**: `npm run build:admin` (or `npm run build --workspace=apps/admin-cms`)
- **Start Command**: `npm run start --workspace=apps/admin-cms` (or `next start` inside `apps/admin-cms`)
- **Health Check Endpoint**: `/api/health` (Returns HTTP 200 with sanitized configuration classifications)

---

## 3. Environment Variable Specification

### A. Required Browser-Safe Variables
*These variables are bundled into client-side code and must not contain secret tokens.*

| Variable | Required | Description |
| :--- | :--- | :--- |
| `NEXT_PUBLIC_SUPABASE_URL` | **Yes** | Secure HTTPS endpoint of the active staging Supabase instance (e.g. `https://sqkpceeltukbzxpsvinb.supabase.co`). |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | **Yes** | Modern publishable API key (or legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`). |

### B. Required Server-Only Variables
*These variables are accessed strictly by Next.js Server Components and route handlers. They must NEVER be prefixed with `NEXT_PUBLIC_` or exposed to browser bundles.*

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `SUPABASE_SECRET_KEY` | **Yes** | — | Modern database administrative secret key (preferred over legacy `SUPABASE_SERVICE_ROLE_KEY`). |
| `CAPSTONE_AUTH_FLOW_SECRET` | **Yes** | — | Dedicated server-only value containing at least 32 random bytes. Signs short-lived password-recovery context cookies and must not reuse any provider, database, JWT, or SMTP secret. |
| `SUPABASE_DRAFT_BUCKET` | Optional | `project-drafts-private` | Private Storage bucket for unapproved project uploads and drafts. |
| `SUPABASE_PUBLIC_ASSETS_BUCKET` | Optional | `project-public-assets` | Public Storage bucket for approved poster and snapshot media assets. |
| `SUPABASE_PUBLIC_FEEDS_BUCKET` | Optional | `public-feeds` | Public Storage bucket holding compiled public JSON feed artifacts. |
| `SUPABASE_PUBLIC_FEED_FILE` | Optional | `capstones-latest.json` | Public JSON showcase feed object name. |

### C. Staging Target Identity Guards
*Required by CLI staging operations and diagnostic checkers to prevent accidental target execution.*

| Variable | Value | Description |
| :--- | :--- | :--- |
| `CAPSTONE_RUNTIME_ENV` | `staging` | Runtime identity flag ensuring staging execution context. |
| `CAPSTONE_EXPECTED_SUPABASE_HOST` | `sqkpceeltukbzxpsvinb.supabase.co` | Technical exact-host target boundary. Mismatches block client creation. |
| `CAPSTONE_STAGING_MUTATION_CONFIRMATION` | `capstone-admin-cms-staging-v2-2026` | Environment-portable, non-secret human mutation acknowledgement label. Configured per environment without code changes; required by `--confirm-staging=<label>`. Does not replace technical hostname verification. |

### D. Optional Features (Default: Fail-Closed / Disabled)
*The core Admin/CMS workflow functions completely without external AI or email services. All optional integrations fail closed by default:*

| Variable | Default | Behavior when False / Absent |
| :--- | :--- | :--- |
| `GEMINI_ASSISTIVE_EXTRACTION_ENABLED` | `false` | AI-assisted metadata extraction disabled. Manual entry and deterministic parsing remain operational. |
| `PARTICIPANT_PREVIEW_EMAIL_ENABLED` | `false` | Email delivery disabled. Generate-and-send returns `EMAIL_DELIVERY_DISABLED`; manual token generation remains operational. |
| `PARTICIPANT_PREVIEW_REMINDERS_ENABLED` | `false` | Reminder scheduler disabled. Scheduled reminders are skipped safely. |
| `STAFF_PROVISIONING_ENABLED` | `false` | New staff invitations and staging-only direct UAT account creation are disabled. Existing pending invitations can still be activated. Direct creation additionally requires exact staging runtime and Supabase-host identity checks. |

---

## 4. Synthetic Stakeholder Demo Workflow

Following hosted staging database setup and administrator linking, stakeholders can execute the complete end-to-end management workflow using synthetic test data:

```mermaid
sequenceDiagram
    autonumber
    actor Staff as School Administrator
    actor Participant as Project Creator
    participant CMS as Admin/CMS Service
    participant DB as Hosted Supabase

    Staff->>CMS: 1. Sign in via /login (Verified admin account)
    Staff->>CMS: 2. Import synthetic project package (.zip / folder)
    Staff->>CMS: 3. Cross-check against Admin Excel reference dataset
    Staff->>CMS: 4. Stage & verify private draft media (alt text & accessibility)
    Staff->>CMS: 5. Submit batch projects to review
    Staff->>CMS: 6. Review & approve metadata (Project status -> approved)
    Staff->>CMS: 7. Generate secure participant preview link (Approved version)
    Participant->>CMS: 8. Access preview URL & confirm exact version
    Staff->>CMS: 9. Execute publication readiness verification
    Staff->>CMS: 10. Prepare publication snapshot & compile public feed
```

1. **Staff Sign-In**: Authenticate using the verified initial administrator account at `/login`.
2. **Package Ingestion**: Upload a synthetic project folder package containing `project-details.xlsx`, poster image, poster PDF, and snapshot image.
3. **Admin Reference Reconciliation**: Cross-check imported metadata against the synthetic Admin Reference workbook to verify reconciliation logic.
4. **Media Staging**: Stage private draft assets; verify image dimensions, poster full text, poster accessibility text, and snapshot image alt text.
5. **Batch Submission**: Submit batch to review; database enforces accessibility validation gates.
6. **Review & Approve**: As a reviewer, inspect project fields and transition project status to `approved`.
7. **Participant Preview Generation**: Generate a secure preview link for the approved project version (token hash persisted; raw token shown once).
8. **Participant Confirmation**: Participant accesses preview URL and submits confirmation for the exact approved version.
9. **Publication Readiness Check**: Execute `get_project_publication_readiness` verification (the database contract requires the project to already be in `approved` status, with confirmed preview evidence and complete accessibility texts).
10. **Publication Preparation**: Compile and validate public feed snapshot via the controlled publication workflow.

> [!NOTE]
> There is no ordinary second "final approval" step after participant confirmation. The domain model and database contract require the project to be reviewed and transitioned to `approved` status prior to preview generation and publication readiness checks.

### Publication Safety Boundary
Stakeholder staging testing does **NOT** automatically authorize:
- Live Duda platform mutation or content publishing;
- Production or public-feed cutover;
- Outgoing email delivery to real participant addresses.

Controlled staging preparation and synthetic demonstration remain strictly isolated from live public systems.

---

## 5. Current Clean-Staging Lifecycle State vs Historical Reconciliation

### A. Current v2 Clean Staging Environment State
The active staging environment (`capstone-admin-cms-staging-v2-2026`, ref `sqkpceeltukbzxpsvinb`) was initialized via clean baseline migration deployment:
- **Migration Inventory**: Exactly 26 migrations (`0001` through `0026`) applied sequentially and recorded in `supabase_migrations.schema_migrations`.
- **Relational Schema**: All 23 public application tables and 42 service-role application RPC signatures across 41 names verified.
- **Storage Buckets**: All 3 buckets (`project-drafts-private`, `project-public-assets`, `public-feeds`) created and configured; 0 storage objects.
- **Administrator Identity**: Initial staging administrator bootstrap completed; single Auth identity linked to `admin_users` profile with verified `admin` role in `user_roles` (`check:admin-auth` classification: `READY_FOR_MANUAL_LOGIN_TEST`).
- **Next Lifecycle Action**: Standalone Admin/CMS hosted web service deployment and manual authenticated login verification.

Migration `0027` is newer than the 26-migration hosted evidence above and remains repository/local-only. The staging-only direct UAT account control must remain unavailable until a separately authorized hosted migration and application deployment is completed and independently reviewed.

Operators should **NOT** run `supabase migration repair` or replay migrations against this clean v2 environment.

### B. Legacy Reconciliation Reference
The procedures detailed in the [staging reconciliation runbook](../infra/supabase/staging-reconciliation-runbook.md) were designed specifically for diagnosing and reconciling the historical drifted staging instance (`fewcbklmbgzglfgedtvt`). That documentation is preserved as an audit trail and fallback procedure, but does not apply to routine maintenance of the clean v2 environment.

---

## 6. Pre-Deployment Readiness Verification

### A. Automated Readiness Inspection Contract
The read-only deployment readiness checker inspects the target endpoint without performing mutations:

```bash
npm run check:admin-deployment-readiness
```

**Automated Inspection Boundaries & Expected Output**:
The automated checker queries the PostgREST Data API and OpenAPI schema. It intentionally reports `DEPLOYMENT_CLASSIFICATION = MANUAL_EVIDENCE_REQUIRED` (with exit code `2`) when evaluating hosted environments because:
- **Migration Tracking**: The Supabase Data API does not expose `supabase_migrations.schema_migrations`, so migration history is unreadable via standard client queries.
- **Constraints & Grants**: Exact foreign key constraints, check constraints, and RLS grants cannot be proven by PostgREST inspection alone.
- **RPC Signatures**: OpenAPI metadata proves RPC names, but may collapse or omit full overloaded parameter signatures.
- **Fail-Closed Design**: The checker deliberately refuses to synthesize `SCHEMA_BASELINE = MATCH` or `READY_FOR_MUTATION_DECISION` without explicit, governed Gate 3/4 manual verification inputs.

Expected automated inspection output on the clean v2 staging target:
- `TARGET_IDENTITY_MATCH = YES`
- `MIGRATION_HISTORY_READABLE = NO`
- `SCHEMA_BASELINE = UNVERIFIED`
- `REQUIRED_TABLE_SET = PRESENT` (All 23 public application tables detected)
- `REQUIRED_RPC_NAMES = PRESENT` (All 41 application RPC names detected)
- `REQUIRED_STORAGE_BUCKETS = PRESENT` (All 3 buckets detected)
- `AUTH_FOUNDATION = READY`
- `MANUAL_EVIDENCE_REQUIRED = YES`
- `DEPLOYMENT_CLASSIFICATION = MANUAL_EVIDENCE_REQUIRED`

### B. Governed Staged Activation Evidence (Clean v2 Baseline)
The active staging environment (`capstone-admin-cms-staging-v2-2026`) was cleared through the governed activation process (Groups D–F), providing the independent contract evidence that automated inspection cannot synthesize:
- **Migration History (Gate 3)**: All 26 migrations in the recorded hosted baseline (`0001` through `0026`) were applied sequentially and verified in remote migration history via the Supabase CLI (`supabase migration list --linked`). Repository migration `0027` was added later and is not part of this hosted evidence.
- **Schema & Grants (Gate 4)**: Exact 23 public tables, 42 service-role application RPC signatures across 41 names, and least-privilege Data API grants verified against migration definitions.
- **Storage Infrastructure (Group E)**: All 3 Storage buckets (`project-drafts-private`, `project-public-assets`, `public-feeds`) created and configured; 0 storage objects.
- **Administrator Auth Linkage (Group F)**: Single Auth identity linked to `admin_users` profile with `admin` role in `user_roles`.

Auth readiness is verified via:

```bash
npm run check:admin-auth
```

Expected output:
- `classification = READY_FOR_MANUAL_LOGIN_TEST`
- `admin_users_count = 1`
- `linked_auth_users_count = 1`
- `recognized_role_assignments = 1` (Role: `admin`)
- `error_codes = NONE`

With both automated object detection and governed activation evidence complete, the clean v2 environment is verified and cleared for standalone Admin/CMS web service deployment.
