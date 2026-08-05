# Onboarding Verification Matrix (`docs/onboarding-verification-matrix.md`)

This matrix details the empirical verification coverage and status across supported execution environments for the Capstone Impact Platform (`acmis1/capstone-impact-platform`).

## Onboarding Completion Standard & Governance

- **Completion Gate**: `AUTOMATED_ONBOARDING_COMPLETE` is achieved when all required automated static quality gates and full-stack local/CI container integration tests pass.
- **Human Onboarding**: No independent human onboarding trial was performed (`HUMAN_ONBOARDING_NOT_PERFORMED`). Human trials are informational and not blocking release criteria.
- **Hosted Boundaries**: No private credentials, hosted dashboards, or shared remote staging/production environments are required for normal local development.

---

## Onboarding Matrix

| Verification Area | Windows (Local Host) | Ubuntu 24.04 (GitHub Actions CI) | macOS (Static CI) | Evidence & Contract Source |
| --- | --- | --- | --- | --- |
| **Package Installation (`npm ci`)** | `PASS` | `PASS` | `PASS` | `package-lock.json` clean install |
| **Onboarding Precheck (`npm run onboarding:check`)** | `PASS` | `PASS` | `LIMITED TO STATIC ACCEPTANCE` | `src/scripts/onboardingCheck.ts` |
| **Doc Contract (`npm run check:onboarding-docs`)** | `PASS` | `PASS` | `PASS` | `src/scripts/checkOnboardingDocs.ts` |
| **Terminology Check (`npm run check:terminology`)** | `PASS` | `PASS` | `PASS` | `src/scripts/repositoryChecks.ts` |
| **YAML Parse Check (`npm run check:yaml`)** | `PASS` | `PASS` | `PASS` | `src/scripts/repositoryChecks.ts` |
| **Markdown Link Check (`npm run check:markdown-links`)** | `PASS` | `PASS` | `PASS` | `src/scripts/repositoryChecks.ts` |
| **Feed Schema Check (`npm run check:feed`)** | `PASS` | `PASS` | `PASS` | `src/scripts/checkSampleFeed.ts` |
| **Targeted First-Contrib Test** | `PASS` | `PASS` | `PASS` | `docs/first-contribution.md` example |
| **Full Unit & Security Tests (`npm run test:admin`)** | `PASS` (472/472) | `PASS` (472/472) | `PASS` (472/472) | Vitest test suite |
| **TypeScript Typecheck (`npm run typecheck:admin`)** | `PASS` | `PASS` | `PASS` | `tsc --noEmit` |
| **Next.js Production Build (`npm run build:admin`)** | `PASS` | `PASS` | `PASS` | `next build` |
| **Full Verification Suite (`npm run verify:all`)** | `PASS` (12/12) | `PASS` (12/12) | `PASS` (12/12) | `src/scripts/verifyAll.ts` |
| **Local Supabase Container Stack (`setup:local`)** | `PASS` | `PASS` | `NOT EXECUTED` (No Docker on macOS runner) | Supabase CLI `2.109.1` Docker containers |
| **Idempotent Re-Setup (`setup:local` rerun)** | `PASS` | `PASS` | `NOT EXECUTED` | Non-destructive reset check |
| **8 PostgreSQL Migrations Replay** | `PASS` | `PASS` | `NOT EXECUTED` | `infra/supabase/migrations/` |
| **Synthetic Staff Account Provisioning** | `PASS` | `PASS` | `NOT EXECUTED` | `apps/admin-cms/.local-users.json` |
| **Synthetic Staff Real Password Sign-In** | `PASS` | `PASS` | `NOT EXECUTED` | Admin, Reviewer, Editor synthetic logins |
| **Non-Loopback Target Refusal** | `PASS` | `PASS` | `NOT EXECUTED` | `src/scripts/verifyLocalSupabase.ts` |
| **File Byte Preservation on Refusal** | `PASS` | `PASS` | `NOT EXECUTED` | Loopback safety unit tests |
| **Admin Application `/api/health` 200 OK** | `PASS` | `PASS` | `NOT EXECUTED` | Application smoke runner |
| **Admin Application `/login` 200 OK** | `PASS` | `PASS` | `NOT EXECUTED` | Application smoke runner |
| **Clean Stack Shutdown (`supabase:stop`)** | `PASS` | `PASS` | `NOT EXECUTED` | Stack assertion scripts |
| **Contributor Workflow Rehearsal** | `PASS` (Local Host) | `PASS` (Dedicated Ubuntu CI Job) | `LIMITED TO STATIC ACCEPTANCE` | `src/scripts/rehearseOnboardingWorkflow.ts` |
| **Clean Tracked Working Tree (`git status`)** | `PASS` | `PASS` | `PASS` | `git status --short` |

---

## Status Classification Reference

- `AUTOMATED_ONBOARDING_COMPLETE`: All 12 static quality gates and full local/CI integration tests pass cleanly.
- `AUTOMATED_ONBOARDING_VERIFIED`: Specific automated component or workflow check passed.
- `HUMAN_ONBOARDING_NOT_PERFORMED`: Independent human developer trial was not performed.
