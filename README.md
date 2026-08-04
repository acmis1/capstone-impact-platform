# Capstone Impact Platform

The Capstone Impact Platform is a school-owned Admin/CMS and automation layer for collecting, reviewing and publishing capstone project showcases.

Manual email, spreadsheet, poster and Duda publishing workflows are difficult to validate and repeat at scale. This project introduces structured project records, validation, review controls and a stable publishing boundary while preserving the existing public showcase as the presentation layer.

The current hybrid design is: staff operate the Admin/CMS, authenticated server-side services manage source data in Supabase, and public-eligible (`approved` and `published`) records are compiled into stable JSON for Duda. `Prototype/` is retained as historical feasibility evidence, not as the active application.

> [!IMPORTANT]
> **NEW DEVELOPERS / CONTRIBUTORS**: Start with [`START_HERE.md`](./START_HERE.md) for a zero-instruction setup guide, prerequisite installation, daily commands, and synthetic login steps.
> Active development is in [`apps/admin-cms/`](./apps/admin-cms/). It is a production-oriented staging implementation. Staging operations are isolated from the live public showcase, synthetic data is required, and production cutover plus full reviewer/editor UAT remain pending.

## Why the project exists

The target workflow needs structured submissions, validation, review, archival and repeatable publishing. Moving source data and operational control into a school-owned system reduces manual duplication while allowing the established public showcase to remain the presentation surface.

## Key capabilities

| Area | Current status |
| --- | --- |
| Admin/CMS foundation | Authenticated internal shell, protected routes and operational project dashboard are implemented. |
| Project index | Server-side search, filters, whitelisted sorting, exact-count pagination and deterministic ordering are implemented. |
| Review | Project inspection and atomic, transaction-backed review actions (`approve`, `request_changes`, `archive`) via PostgreSQL RPC `perform_project_review_action` are implemented. |
| Ingestion | Package parsing, metadata/file validation, import-batch tracking and import-review foundations are implemented. |
| Media and feed | Private draft storage, validated promotion foundations and public-eligible JSON feed compilation are implemented. |
| Local Supabase | Pinned CLI 2.109.1, 8 timestamped migrations, 3 local storage buckets, synthetic staff provisioning and automated verifier implemented. *(Migrations 0007 and 0008 are repository/local only and not applied to hosted staging.)* |
| Staging Guardrails | Target environment identity checks, hostname matching, loopback rejection and double-acknowledgement CLI flags implemented. |
| Quality & Onboarding | Node 24.14.1 and npm 11.11.0 toolchain contract, `npm run onboarding:check` precheck, and unit tests implemented. Verified in a clean Windows remote-clone run; macOS, Linux and independent human onboarding remain unverified. |
| Pending | Hosted migration reconciliation, hosted staff lifecycle, interactive browser UAT matrix, cross-platform human onboarding verification and production cutover. |

## Architecture

```mermaid
flowchart LR
    A[Staff browser] --> B[Next.js Admin/CMS]
    B --> C[Authenticated server-side services]
    C --> D[Supabase Auth, Postgres and Storage]
    D --> E[Public-eligible stable JSON feed]
    E -. pending controlled cutover .-> F[Duda public showcase]
```

Staff use the protected Next.js application. Server-side authentication and authorization mediate access to Supabase using modern server key preference (`SUPABASE_SECRET_KEY` preferred with `SUPABASE_SERVICE_ROLE_KEY` fallback). Browser clients use `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. The feed compiler removes internal fields and includes public-eligible `approved` and `published` records; all other workflow states are excluded. The architecture supports Duda as the public consumer, but staging feed output remains isolated from the live showcase until a controlled cutover.

## Repository structure

| Path | Purpose | Status |
| --- | --- | --- |
| [`apps/admin-cms/`](./apps/admin-cms/) | Active Next.js Admin/CMS application. | Active implementation and staging operations |
| [`infra/supabase/`](./infra/supabase/) | Versioned schema, RLS, grants and database runbooks. | Operational infrastructure documentation |
| [`docs/`](./docs/) | Architecture, UI, integration and project constraints. | Operational and planning documentation |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Contributor workflow, branch rules, and safety contract. | Authoritative developer governance guide |
| [`Prototype/`](./Prototype/) | Earlier feasibility/demo application. | Historical evidence only |
| [`package.json`](./package.json) | Root npm workspace and convenience scripts. | Active repository contract |

## Quick start

From a fresh checkout (no hosted keys or organization access needed for local development):

Prerequisites:
- **Node.js**: `>= 24.14.1 < 25` (Pinned via `.nvmrc` to `24.14.1`)
- **npm**: `>= 11.11.0 < 12` (Declared in `packageManager` as `npm@11.11.0`)
- **Docker Desktop / Engine**: Must be active locally.

1. Clean install dependencies:

   ```bash
   npm ci
   ```

2. Run automated onboarding precheck (12 checks):

   ```bash
   npm run onboarding:check
   ```

3. Start local Supabase development stack:

   ```bash
   npm run setup:local
   ```

   This command is safe to rerun and does not rebuild the local database. Run `npm run supabase:reset` separately only for an intentional clean reconstruction.

4. Start the Next.js development server:

   ```bash
   npm run dev:admin
   ```

5. Open [http://localhost:3000/login](http://localhost:3000/login) and log in using synthetic credentials from `apps/admin-cms/.local-users.json` (verifies `admin`, `reviewer`, and `editor` synthetic staff accounts via local GoTrue password login).

6. Clean up local stack when finished:

   ```bash
   npm run supabase:stop
   ```

For detailed contributor guidelines and branch rules, see the [Contributor Guide](./CONTRIBUTING.md). For local database setup details, see the [Local Development Guide](./infra/supabase/local-development.md). Offline unit tests and the sample-feed check (`npm run check:feed`) do not require private dashboard access or hosted database connections.

## Validation commands

Run from the repository root:

| Check | Command |
| --- | --- |
| Onboarding Precheck | `npm run onboarding:check` |
| Lint | `npm run lint --workspace=apps/admin-cms` |
| Tests | `npm run test:admin` |
| Typecheck | `npm run typecheck:admin` |
| Build | `npm run build:admin` |
| Public-feed contract | `npm run check:feed` |

## Documentation map

| Document | Role |
| --- | --- |
| [`START_HERE.md`](./START_HERE.md) | Developer onboarding guide, daily workflow, and commands. |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Contributor workflow, branch rules, and safety contract. |
| [`apps/admin-cms/README.md`](./apps/admin-cms/README.md) | Authoritative developer and staging-operator guide. |
| [`infra/supabase/local-development.md`](./infra/supabase/local-development.md) | Local Supabase environment setup and onboarding guide. |
| [`infra/supabase/staging-reconciliation-runbook.md`](./infra/supabase/staging-reconciliation-runbook.md) | 7-gate hosted database migration reconciliation runbook. |
| [`infra/supabase/key-migration-governance.md`](./infra/supabase/key-migration-governance.md) | Supabase key rotation and server key preference standards. |
| [`infra/supabase/staff-lifecycle-design.md`](./infra/supabase/staff-lifecycle-design.md) | Staff lifecycle governance and offboarding design. |
| [`infra/supabase/staging-auth-verification.md`](./infra/supabase/staging-auth-verification.md) | Controlled authentication and authorization verification runbook. |
| [`docs/README.md`](./docs/README.md) | Operational and planning documentation index. |
| [`docs/admin-cms-ui-system.md`](./docs/admin-cms-ui-system.md) | Current UI and information-architecture contract. |
| [`docs/duda-integration-plan.md`](./docs/duda-integration-plan.md) | Public-feed and Duda integration design/plan. |
| [`infra/supabase/README.md`](./infra/supabase/README.md) | Supabase infrastructure and governance index. |
| [`infra/supabase/manual-apply-guide.md`](./infra/supabase/manual-apply-guide.md) | Operational staging command reference. |

## Security and data handling

- Never commit `.env` or `.env.local` files.
- Modern server key preference (`SUPABASE_SECRET_KEY`) is preferred over legacy service-role key fallback for server administration.
- Keep server-only credentials out of browser code and Client Components.
- Autonomous agents must not access private administrative dashboards.
- Use synthetic fixtures only; real project participant, staff or stakeholder personal data is prohibited in staging.
- Keep `Prototype/` and staging environments isolated.
- Hosted state-changing commands remain strictly prohibited without explicit project-owner approval.

## Roadmap

Implemented foundations include the authenticated Admin/CMS shell, project index, validation, import and media workflows, reproducible local Supabase stack, shared-staging execution guardrails, key preference model and public-eligible feed compiler.

Remaining work includes hosted migration history reconciliation, controlled hosted staff lifecycle tooling, interactive browser UAT matrix validation, metadata editor, participant confirmation, preview and publication-history workflows, accessibility QA, production deployment hardening and controlled Duda cutover. Phase 4 is not represented as implemented.

Developer contribution policies and security boundaries are defined in [`CONTRIBUTING.md`](./CONTRIBUTING.md).
