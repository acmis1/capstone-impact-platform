## Summary

Brief summary of the changes introduced by this pull request.

## Linked Issue

Closes #<!-- ISSUE NUMBER -->

## Pre-Merge Checklist & Quality Gates

Please verify all applicable checkboxes before requesting review:

- [ ] **Narrow Branch**: Created on a narrow feature branch (`docs/*`, `feat/*`, `fix/*`, `infra/*`, `security/*`) targeting `main`.
- [ ] **Linked Issue**: Linked to an assigned GitHub issue (one issue per branch).
- [ ] **Explicit Files Staged**: Staged explicit file paths only (did NOT use `git add .` or `git add -A`).
- [ ] **No Direct Main Work**: Did not commit directly to `main` branch.
- [ ] **Migrations Added or Unchanged**: New schema changes use a 14-digit timestamped SQL file in `infra/supabase/migrations/`.
- [ ] **Migrations 0001–0008 Not Edited**: Merged migrations `0001` through `0008` remain completely unchanged.
- [ ] **Synthetic Data Only**: Used synthetic mock data only. Zero real student, staff, or supervisor identity data.
- [ ] **No Hosted Resources Touched**: Local development ran entirely on loopback (`127.0.0.1`). Zero hosted dashboards or services were accessed.
- [ ] **Onboarding Check**: `npm run onboarding:check` passed all 12 checks.
- [ ] **Feed Check**: `npm run check:feed` passed public feed contract validation.
- [ ] **Lint**: `npm run lint --workspace=apps/admin-cms` passed with 0 errors and 0 warnings.
- [ ] **Tests**: `npm run test:admin` passed all unit and security tests.
- [ ] **Typecheck**: `npm run typecheck:admin` passed with 0 TypeScript errors (`tsc --noEmit`).
- [ ] **Build**: `npm run build:admin` built Next.js successfully without errors.
- [ ] **Diff Check**: `git diff --check` passed cleanly without trailing whitespace or syntax warnings.
- [ ] **Documentation Update**: Updated READMEs, backlog, or inline documentation to reflect all changes.
- [ ] **Screenshots / Evidence**: Added screenshots or terminal execution evidence where applicable.
- [ ] **Known Limitations**: Documented remaining limitations or unverified platforms (e.g., macOS/Linux).

## Verification Evidence & Output

```text
<!-- Paste npm run verify:all or validation summary here -->
```
