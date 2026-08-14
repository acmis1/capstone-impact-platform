# Admin/CMS Hosted Staging Deployment Guide

This document defines the deployment contract, service architecture, environment configuration, and synthetic stakeholder verification workflow for deploying the Admin/CMS (`apps/admin-cms`) to a hosted staging environment.

---

## 1. Architectural Separation & Hosting Strategy

The Capstone platform enforces strict architectural and operational isolation between the feasibility Prototype and the production-oriented Admin/CMS application:

| Attribute | Prototype Service | Admin/CMS Service |
| :--- | :--- | :--- |
| **Directory** | `Prototype/` | `apps/admin-cms/` |
| **Service Role** | Historical feasibility & public Duda presentation support | Authenticated school administration & CMS source of truth |
| **Supabase Instance** | Prototype recovery project | Isolated staging project (`capstone-admin-cms-staging-2026`) |
| **Hosting Service** | Existing Render static/web service | **Separate** Render/Cloud Web Service |
| **Database Mutations** | Prohibited | Controlled via 7-gate reconciliation governance |

> [!IMPORTANT]
> The existing Render service configured for `Prototype/` must **NEVER** be repurposed or pointed to `apps/admin-cms`. The Admin/CMS requires an independent web service with its own environment variables and deployment pipeline.

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
| `NEXT_PUBLIC_SUPABASE_URL` | **Yes** | Secure HTTPS endpoint of the isolated staging Supabase instance (e.g. `https://<staging-ref>.supabase.co`). |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | **Yes** | Modern publishable API key (or legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`). |

### B. Required Server-Only Variables
*These variables are accessed strictly by Next.js Server Components and route handlers. They must NEVER be prefixed with `NEXT_PUBLIC_` or exposed to browser bundles.*

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `SUPABASE_SECRET_KEY` | **Yes** | — | Modern database administrative secret key (preferred over legacy `SUPABASE_SERVICE_ROLE_KEY`). |
| `SUPABASE_DRAFT_BUCKET` | Optional | `project-drafts-private` | Private Storage bucket for unapproved project uploads and drafts. |
| `SUPABASE_PUBLIC_ASSETS_BUCKET` | Optional | `project-public-assets` | Public Storage bucket for approved poster and snapshot media assets. |
| `SUPABASE_PUBLIC_FEEDS_BUCKET` | Optional | `public-feeds` | Public Storage bucket holding compiled public JSON feed artifacts. |
| `SUPABASE_PUBLIC_FEED_FILE` | Optional | `capstones-latest.json` | Public JSON showcase feed object name. |

### C. Staging Target Identity Guards
*Required by CLI staging operations and diagnostic checkers to prevent accidental target execution.*

| Variable | Value | Description |
| :--- | :--- | :--- |
| `CAPSTONE_RUNTIME_ENV` | `staging` | Runtime identity flag. |
| `CAPSTONE_EXPECTED_SUPABASE_HOST` | `<staging-ref>.supabase.co` | Expected hostname used to verify target identity match. |

### D. Optional Features (Default: Fail-Closed / Disabled)
*The core Admin/CMS workflow functions completely without external AI or email services. All optional integrations fail closed by default:*

| Variable | Default | Behavior when False / Absent |
| :--- | :--- | :--- |
| `GEMINI_ASSISTIVE_EXTRACTION_ENABLED` | `false` | AI-assisted metadata extraction disabled. Manual entry and deterministic parsing remain operational. |
| `PARTICIPANT_PREVIEW_EMAIL_ENABLED` | `false` | Email delivery disabled. Generate-and-send returns `EMAIL_DELIVERY_DISABLED`; manual token generation remains operational. |
| `PARTICIPANT_PREVIEW_REMINDERS_ENABLED` | `false` | Reminder scheduler disabled. Scheduled reminders are skipped safely. |
| `STAFF_PROVISIONING_ENABLED` | `false` | New staff invitation creation disabled. Existing pending invitations can still be activated. |

---

## 4. Synthetic Stakeholder Demo Workflow

Following hosted staging database reconciliation, stakeholders can execute the complete end-to-end management workflow using synthetic test data:

```mermaid
sequenceDiagram
    autonumber
    actor Staff as School Administrator
    actor Participant as Project Creator
    participant CMS as Admin/CMS Service
    participant DB as Hosted Supabase

    Staff->>CMS: 1. Sign in via /login (Synthetic credentials)
    Staff->>CMS: 2. Import synthetic project package (.zip / folder)
    Staff->>CMS: 3. Cross-check against Admin Excel reference dataset
    Staff->>CMS: 4. Stage & verify private draft media
    Staff->>CMS: 5. Submit batch projects to review
    Staff->>CMS: 6. Review & approve metadata (Reviewer role)
    Staff->>CMS: 7. Generate secure participant preview link
    Participant->>CMS: 8. Confirm exact preview version
    Staff->>CMS: 9. Grant final project approval
    Staff->>CMS: 10. Prepare publication snapshot
```

1. **Staff Sign-In**: Authenticate using the verified initial administrator account at `/login`.
2. **Package Ingestion**: Upload a synthetic project folder package containing `project-details.xlsx`, poster image, poster PDF, and snapshot image.
3. **Admin Reference Reconciliation**: Cross-check imported metadata against the synthetic Admin Reference workbook to verify reconciliation logic.
4. **Media Staging**: Stage private draft assets; verify image dimensions and alt text requirements.
5. **Batch Submission**: Submit batch to review; database enforces accessibility validation gates.
6. **Review Action**: As a reviewer, inspect project fields and transition status to `approved`.
7. **Participant Preview**: Generate a secure preview link (token hash persisted; raw token shown once).
8. **Participant Confirmation**: Access preview URL and submit confirmation for the exact version.
9. **Final Approval**: Review confirmed status and grant approval.
10. **Publication Preparation**: Compile and validate public feed snapshot. *(Note: Live public Duda cutover remains separately governed).*

---

## 5. Next Operator Decision Paths

Before hosted deployment activation, the operator must execute the read-only deployment readiness checker:

```bash
npm run check:admin-deployment-readiness
```

Based on the output classification, select the appropriate path:

### PATH A: Manual Evidence Completion (`MANUAL_EVIDENCE_REQUIRED`)
- **Condition**: The automated GET/HEAD inspection finds all 23 public application tables, all 41 application RPC names represented by 42 authoritative signatures, and all 3 buckets, with no visible unexpected public relations. The Data API cannot read `supabase_migrations.schema_migrations`, and PostgREST OpenAPI may collapse overloads, so exact migrations, signatures, constraints, and grants remain unverified.
- **Next Step**: Complete read-only Gates 3 and 4 in the [staging reconciliation runbook](../infra/supabase/staging-reconciliation-runbook.md). Only their combined evidence can support a human `READY_FOR_MUTATION_DECISION`.

### PATH B: Full Match (`READY_FOR_MUTATION_DECISION`)
- **Condition**: All automated evidence plus governed Gate 3/4 evidence proves all 26 migrations, 23 tables, 42 RPC signatures, exact constraints/grants, and no unexpected schema objects.
- **Next Step**: Authorize deployment of the Admin/CMS web service.

### PATH C: Migration Reconciliation Required (`RECONCILIATION_REQUIRED`)
- **Condition**: Hosted database has baseline migrations 0001–0006 applied, but tracking history is unpopulated or forward migrations 0007–0026 are pending.
- **Next Step**: Follow [staging-reconciliation-runbook.md](../infra/supabase/staging-reconciliation-runbook.md) Gate 6 to repair baseline tracking and apply forward migrations under explicit authorization.

### PATH D: Schema Drift or Guard Failure (`DRIFT_REQUIRES_REVIEW` or `BLOCKED`)
- **Condition**: Hostname mismatch, conflicting schema evidence, or OpenAPI-visible unexpected public relations.
- **Next Step**: STOP immediately. Do NOT run `db push`. Formulate an explicit schema remediation plan.
