# First Contribution Guide (`docs/first-contribution.md`)

This step-by-step guide walks a new developer through completing a hypothetical, beginner-safe local task on the Capstone Impact Platform.

---

## 1. Updating `main`

Before starting any new task, ensure your local `main` branch is synchronized with the remote repository:

```bash
git checkout main
git pull --ff-only origin main
```

---

## 2. Creating a Feature Branch

Create a narrow feature branch from `main` using an appropriate prefix (`docs/*`, `feat/*`, `fix/*`, `infra/*`, `security/*`):

```bash
git checkout -b fix/demo-local-notice
```

---

## 3. Confirming the Worktree is Clean

Check your working directory status to ensure no unexpected tracked or untracked modifications exist:

```bash
git status --short
```

---

## 4. Identifying Relevant Files

Use the repository file map (in `START_HERE.md` or `apps/admin-cms/README.md`) to locate the files related to your assigned issue.

For example, to update the admin header UI:
- `apps/admin-cms/src/components/admin-shell/`

To update project review route handling:
- `apps/admin-cms/src/app/api/projects/[publicId]/review-action/route.ts`

To add a database migration:
- `infra/supabase/migrations/` (new 14-digit timestamped `.sql` file)

---

## 5. Making a Small Change

Edit only the specific file(s) required for your task.

*Example (Hypothetical UI update in `apps/admin-cms/src/components/admin-shell/Header.tsx`):*
Modify a label or helper tooltip as requested in your assigned issue.

Do not edit unrelated files, formatting, or comments in surrounding code.

---

## 6. Locating Nearby Tests

Tests in `apps/admin-cms` are located alongside code files or inside `src/security/`:
- UI / logic test files end with `.test.ts` or `.test.tsx` (e.g. `apps/admin-cms/src/domain/project.test.ts`).

---

## 7. Adding or Updating a Test

Add a targeted assertion to an existing `.test.ts` file or create a new test file alongside your code change.

Run your specific test file locally using Vitest:

```bash
npx vitest run apps/admin-cms/src/domain/project.test.ts
```

---

## 8. Running Targeted Validation

Run individual validation checks relevant to your changes:

- **ESLint**: `npm run lint --workspace=apps/admin-cms`
- **TypeScript**: `npm run typecheck:admin`
- **Unit Tests**: `npm run test:admin`

---

## 9. Running Full Repository Validation

Before committing, run the full canonical verification suite:

```bash
npm run verify:all
```

All quality gates (onboarding precheck, feed schema check, lint, tests, typecheck, Next.js build, and diff checks) must pass cleanly.

---

## 10. Inspecting the Diff

Inspect your uncommitted changes to ensure no extraneous modifications or whitespace issues were introduced:

```bash
git diff
git diff --check
```

---

## 11. Staging Explicit Files Only

**NEVER use `git add .` or `git add -A`.** Always stage explicit file paths:

```bash
git add apps/admin-cms/src/components/admin-shell/Header.tsx
```

Verify staged files:

```bash
git status --short
```

---

## 12. Committing Changes

Commit using a clear, conventional message (`type(scope): description`):

```bash
git commit -m "fix(shell): update admin header tooltip guidance"
```

---

## 13. Pushing Your Branch

Push your feature branch to GitHub:

```bash
git push origin fix/demo-local-notice
```

**Do not use `--force` or force-push.**

---

## 14. Opening a Pull Request

1. Go to the repository on GitHub (`https://github.com/acmis1/capstone-impact-platform`).
2. Click **Compare & pull request** for your pushed branch (`fix/demo-local-notice`).
3. Set the base branch to `main`.
4. Fill out all sections of `.github/PULL_REQUEST_TEMPLATE.md`.
5. Link your assigned issue number (e.g., `Closes #123`).
6. Request a review from `@acmis1`. **Self-merging is prohibited.**

---

## 15. Responding to Review Comments

If a reviewer requests changes:
1. Make the requested edits on your feature branch.
2. Re-run `npm run verify:all`.
3. Stage explicit files and commit: `git commit -m "fix(shell): address reviewer feedback"`
4. Push to origin: `git push origin fix/demo-local-notice`. The PR updates automatically.

---

## 16. Stopping Local Services

When finished with development, cleanly stop local Supabase containers:

```bash
npm run supabase:stop
```

---

## 17. What Must NEVER Be Included

- ❌ Real participant, staff, or supervisor personal data (PII).
- ❌ Hardcoded API keys, passwords, secrets, or connection strings.
- ❌ Modified migrations `0001` through `0008`.
- ❌ Files inside `Prototype/` (except documentation links outside `Prototype/`).
- ❌ Hosted environment credentials (`.env.local` or `.local-users.json`).
