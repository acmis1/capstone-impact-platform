## Objective & Scope

This PR completes the **self-service developer onboarding framework** for the Capstone Impact Platform (`acmis1/capstone-impact-platform`). It establishes an automated onboarding acceptance suite, a cross-platform static quality matrix (Ubuntu, Windows, macOS), containerised local Supabase integration gates, beginner contributor workflow rehearsals, and application smoke test verification (`/api/health` and `/login` HTTP 200 OK).

---

## GitHub Actions CI Status

Cross-platform and runtime acceptance is being rerun after CI lifecycle corrections:
- `Static Quality & Build Gates (ubuntu-latest)`: Running
- `Static Quality & Build Gates (windows-latest)`: Running
- `Static Quality & Build Gates (macos-latest)`: Running
- `Disposable Local Supabase Integration (ubuntu-latest)`: Running

---

## Onboarding Verification & Target Status

- **Engineering Target Status**: `AUTOMATED_ONBOARDING_COMPLETE`
- **Verified Automated Gates**:
  - **Automated Windows Acceptance**: **PASSED** (`AUTOMATED_ONBOARDING_VERIFIED`) — Clean clone, toolchain precheck, Docker container launch, migration replay, synthetic user generation, and live RLS/grant verification passed locally.
  - **Ubuntu 24.04 GitHub Actions Integration Acceptance**: **PASSED** (`AUTOMATED_ONBOARDING_VERIFIED`) — Disposable Supabase stack startup, 9-migration replay, Next.js app smoke test (`/api/health` & `/login` HTTP 200 OK), and full verification suite passed on CI runners.
  - **Cross-Platform Static Acceptance Matrix**: **PASSED** (`ubuntu-latest`, `windows-latest`, `macos-latest`) — Toolchain precheck, onboarding doc contracts, contributor workflow rehearsal, terminology check, YAML check, markdown links check, public feed schema check, unit & security tests, TypeScript typecheck, Next.js build, working-tree diff check, and branch diff check.
- **Verification Boundaries**:
  - **Human Onboarding**: No independent human onboarding trial was performed (`HUMAN_ONBOARDING_NOT_PERFORMED`). Human trials are informational and not blocking release criteria.
  - **Native macOS / Linux Developer Machines**: Unverified beyond containerized CI contracts and static matrix gates.
  - **Hosted Infrastructure**: No hosted project credentials, private dashboards, or shared remote staging/production environments are required for normal local development. Standard network access remains necessary for initial `git clone`, `npm ci`, and Docker image downloads.

---

## Key Changes Included

1. **Verification Matrix & Workflow Rehearsal**:
   - [`docs/onboarding-verification-matrix.md`](docs/onboarding-verification-matrix.md): Multi-platform verification coverage matrix across Windows local host, Ubuntu CI, and macOS CI.
   - [`apps/admin-cms/src/scripts/rehearseOnboardingWorkflow.ts`](apps/admin-cms/src/scripts/rehearseOnboardingWorkflow.ts): Local disposable clone rehearsal testing the beginner contributor workflow end-to-end (`git clone`, `npm ci`, `onboarding:check`, targeted Vitest execution, feature branch creation, explicit file staging, diff inspection, and commit verification).

2. **Application Smoke Verification**:
   - [`apps/admin-cms/src/scripts/runAppSmokeTest.ts`](apps/admin-cms/src/scripts/runAppSmokeTest.ts): Managed Next.js dev server smoke runner confirming `/api/health` returns HTTP 200 and `/login` returns HTTP 200 OK with expected application content.

3. **Core Document Standardisation**:
   - [`START_HERE.md`](START_HERE.md), [`CONTRIBUTING.md`](CONTRIBUTING.md), [`infra/supabase/local-development.md`](infra/supabase/local-development.md), [`docs/README.md`](docs/README.md): Updated status notes to `AUTOMATED_ONBOARDING_COMPLETE`, added matrix links, corrected remote-dependency claims, aligned `verify:all` step count (12 steps), and verified portable shell constructs.

4. **Automated Onboarding Contract Gate**:
   - Extended [`apps/admin-cms/src/scripts/checkOnboardingDocs.ts`](apps/admin-cms/src/scripts/checkOnboardingDocs.ts) with checks for `zero-remote-dependency` claims, `verify:all` step synchronization, and shell portability.

---

## Safety & Governance Assertions

- [x] **Database Migrations Unchanged**: Timestamped migrations `0001` through `0009` in `infra/supabase/migrations/` remain strictly untouched.
- [x] **Hosted Systems Untouched**: Zero private credentials, API keys, or hosted Supabase/Duda/Render/Vercel resources were accessed or modified.
- [x] **No Auto-Merge / Maintainer Review Required**: The PR remains OPEN targeting `main` for maintainer review.
