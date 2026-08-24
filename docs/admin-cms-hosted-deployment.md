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
- **Liveness Endpoint**: `/api/health` (always returns a minimal HTTP 200 while the application route handler is running)
- **Render Health Check Endpoint**: `/api/readiness` (returns HTTP 200 only when hosted configuration, staging target identity, and the bounded dependency probe are ready)

### C. HTTP Liveness and Deployment-Readiness Contracts

`/api/health` and `/api/readiness` are deliberately separate signals:

| Endpoint | Success contract | What it proves | What it does not prove |
| :--- | :--- | :--- | :--- |
| `GET /api/health` | HTTP 200 with `{ "app": "admin-cms", "status": "ok" }` | The deployed application can execute a route handler. | Valid environment variables, Supabase reachability, schema state, authentication, publication, UAT, or production acceptance. |
| `GET /api/readiness` | HTTP 200 with `readiness: "ready"`, `classification: "READY"`, `configuration: "configured"`, and `dependency: "reachable"` | Critical server configuration parses, the runtime is verified as the expected HTTPS staging target, and a two-second zero-row Supabase `HEAD` read succeeds. | Applied migration history, exact schema/grants/RPC signatures, Auth or Storage readiness, workflow behavior, full UAT, publication readiness, or production acceptance. |

Readiness failures return HTTP 503 with one of two bounded classifications:

- `CONFIGURATION_NOT_READY`: critical environment configuration or expected staging target identity is missing, malformed, or mismatched; the dependency is reported as `not-checked`.
- `DEPENDENCY_NOT_READY`: configuration is valid but the bounded read-only dependency probe fails, returns a non-success status, or times out; the dependency is reported as `not-ready`.

Every readiness body includes the repository's expected migration count and latest expected migration identifier. This is version evidence from the deployed application bundle, not proof that those migrations are applied to the hosted database. `RENDER_GIT_COMMIT` is returned only when it is exactly a valid 40-character hexadecimal commit identifier; otherwise `deploymentCommit.state` is truthfully `missing` or `invalid` and no untrusted value is echoed.

Both endpoints support `HEAD` with the same status contract and no response body. All liveness and readiness responses use `Cache-Control: no-store` and `Pragma: no-cache` so a prior response is not durable evidence of current state. Configure Render to use `/api/readiness`, not `/api/health`, for the service health-check path.

### D. Read-Only Hosted UAT Smoke Verifier

Run the hosted smoke verifier after a staging deployment or relevant hosted configuration change, and immediately before beginning a supervised UAT session. Supply the service base URL explicitly; the repository does not contain or assume a live Render URL:

```bash
git fetch origin main
npm run check:admin-hosted-smoke -- --base-url=https://admin-cms-staging.example --expected-commit=<full-40-character-origin-main-sha>
```

`--expected-commit` is optional, but when supplied it must be a full 40-character hexadecimal commit and must exactly match the valid deployment commit returned by `/api/readiness`. The base URL must use HTTPS, except for explicit localhost/loopback test fixtures, and cannot contain credentials, a query, or a fragment. The verifier accepts no passwords, cookies, tokens, API keys, or service-role credentials.

The command performs only these bounded, unauthenticated requests:

- `GET` and `HEAD` `/api/health`;
- `GET` and `HEAD` `/api/readiness`;
- `GET` `/login`.

It proves that the exact liveness contract is available, the readiness response is internally consistent and currently `READY`, the login route returns HTML, deployment commit evidence is valid, and the readiness bundle's expected migration count/latest identifier matches the migration files currently checked out in the repository. It also records observed request duration without imposing or inventing a production SLA. Redirects cannot leave the supplied origin or move a request to a different route.

It does **not** authenticate, create a session, submit a login form, inspect private project/media routes, prove that migrations are applied, validate schema or RLS, exercise workflow UAT, publish a feed, mutate Supabase or Duda, send email, deploy the application, or replace independent CI and review. In particular, readiness migration evidence describes what the deployed bundle expects; it is not hosted database migration-history evidence.

The final line is deterministic. `HOSTED_SMOKE_CLASSIFICATION = READY_FOR_SUPERVISED_UAT` means only that the supervised UAT session may begin. Any other classification fails closed and requires investigation. One green smoke run must never be represented as production readiness or as a substitute for the governed schema/RLS and stakeholder UAT checks.

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
*Required by CLI staging operations, diagnostic checkers, and `/api/readiness` to prevent accidental target execution.*

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
| `CAPSTONE_STAGING_PUBLICATION_ENABLED` | `false` | Staging showcase publication is absent from the UI and route fails closed. Exact `true` enables it only when the staging runtime identity and expected Supabase host also match. It never enables live production publication. |

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
    Staff->>CMS: 10. Prepare publication plan (no write)
    Staff->>CMS: 11. Separately authorised staging showcase publication
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
10. **Publication Preparation**: Compile and validate the candidate public feed via the no-write preparation action.
11. **Staging Showcase Publication (separate authorisation required)**: When the server has exact staging identity/host proof and explicit staging-publication enablement, an Admin may acknowledge **Publish to staging showcase**. The existing controlled coordinator promotes approved media, verifies and replaces the stable staging feed, and returns bounded feed/snapshot evidence. See [Duda Integration Plan](duda-integration-plan.md#5-separately-authorised-staging-demonstration) for the exact later demonstration procedure.

> [!NOTE]
> There is no ordinary second "final approval" step after participant confirmation. The domain model and database contract require the project to be reviewed and transitioned to `approved` status prior to preview generation and publication readiness checks.

### Publication Safety Boundary
Stakeholder staging testing does **NOT** automatically authorize:
- Live Duda platform mutation or content publishing;
- Production or public-feed cutover;
- Outgoing email delivery to real participant addresses.

Controlled staging preparation and synthetic demonstration remain strictly isolated from live public systems.

Local publication, staging/test-showcase publication, and live production publication are distinct capabilities. Local remains loopback-only. Staging is fail-closed unless `CAPSTONE_RUNTIME_ENV=staging`, the actual Supabase hostname exactly matches `CAPSTONE_EXPECTED_SUPABASE_HOST`, and `CAPSTONE_STAGING_PUBLICATION_ENABLED=true`. Live production publication remains unavailable: there is no production route or UI control.

---

## 5. Current Clean-Staging Lifecycle State vs Historical Reconciliation

### A. Current v2 Clean Staging Environment State
The active staging environment (`capstone-admin-cms-staging-v2-2026`, ref `sqkpceeltukbzxpsvinb`) was initialized via clean baseline migration deployment:
- **Migration Inventory**: Exactly 26 migrations (`0001` through `0026`) applied sequentially and recorded in `supabase_migrations.schema_migrations`.
- **Relational Schema**: All 23 public application tables and 42 service-role application RPC signatures across 41 names verified.
- **Storage Buckets**: All 3 buckets (`project-drafts-private`, `project-public-assets`, `public-feeds`) created and configured; 0 storage objects.
- **Administrator Identity**: Initial staging administrator bootstrap completed; single Auth identity linked to `admin_users` profile with verified `admin` role in `user_roles` (`check:admin-auth` classification: `READY_FOR_MANUAL_LOGIN_TEST`).
- **Next Lifecycle Action**: Standalone Admin/CMS hosted web service deployment and manual authenticated login verification.

The repository now expects 34 migrations, ending at `20260824120000_bulk_project_review_concurrency`; this is newer than the recorded 26-migration hosted evidence above. That historical evidence must not be treated as proof that migrations `0027`–`0034` are hosted. Any hosted reconciliation remains a separately authorized operation followed by independent review.

Operators should **NOT** run `supabase migration repair` or replay migrations against this clean v2 environment.

### B. Legacy Reconciliation Reference
The procedures detailed in the [staging reconciliation runbook](../infra/supabase/staging-reconciliation-runbook.md) were designed specifically for diagnosing and reconciling the historical drifted staging instance (`fewcbklmbgzglfgedtvt`). That documentation is preserved as an audit trail and fallback procedure, but does not apply to routine maintenance of the clean v2 environment.

---

## 6. Pre-Deployment Readiness Verification

### A. Automated Readiness Inspection Contract
The read-only deployment readiness CLI performs broader schema-object inspection without mutations:

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
- `REQUIRED_TABLE_SET = PRESENT` (All 27 public application tables detected)
- `REQUIRED_RPC_NAMES = PRESENT` (All 57 application RPC names detected)
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

### C. Safe Deployment SHA Verification and Acceptance Boundary

Before relying on a staging deployment, fetch the repository and run the read-only smoke verifier against the exact approved main commit:

```bash
git fetch origin main
npm run check:admin-hosted-smoke -- --base-url=https://admin-cms-staging.example --expected-commit=$(git rev-parse origin/main)
```

The verifier compares `deploymentCommit.value` to that exact 40-character SHA and reports missing, invalid, and mismatched commit evidence as distinct fail-closed classifications. Do not place a branch name, shortened/fabricated SHA, or untrusted value in the comparison. The command remains GET/HEAD-only and performs no deployment or hosted mutation.

A green hosted smoke result is only an application/configuration/dependency and public-login-surface gate. It does not replace the broader read-only schema-object checker, governed migration/schema/RLS evidence, authenticated smoke tests, stakeholder UAT, publication checks, independent CI review, or a production acceptance decision.
