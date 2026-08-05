# First Contribution Guide (`docs/first-contribution.md`)

This step-by-step guide walks a new developer through completing a hypothetical, beginner-safe local task on the Capstone Impact Platform.

---

## 1. Reading the Assigned Issue

Before creating a branch or writing code:
- Read your assigned GitHub Issue carefully.
- Identify the single expected outcome, acceptance criteria, in-scope requirements, and out-of-scope boundaries.
- Do not invent speculative requirements or features missing from the issue description.
- If scope or security rules are unclear, stop and ask the project maintainer on the issue thread before writing code.

---

## 2. Updating `main`

Ensure your local `main` branch is synchronized with the remote repository, dependencies are installed, and local environment is initialized via `npm run setup:local`:

```bash
git checkout main
git pull --ff-only origin main
npm ci
npm run setup:local
```

---

## 3. Creating a Feature Branch

Create a narrow feature branch from `main` using an appropriate prefix (`docs/*`, `feat/*`, `fix/*`, `infra/*`, `security/*`):

```bash
git checkout -b fix/admin-nav-descriptor
```

---

## 4. Confirming the Worktree is Clean

Check your working directory status to ensure no unexpected tracked or untracked modifications exist:

```bash
git status --short
```

---

## 5. Identifying Relevant Files & Inspecting Existing Code

Inspect nearby implementation files and tests first before making changes.

For example, to update navigation route descriptors in the Admin shell:
- Source: [`apps/admin-cms/src/components/admin-shell/navigation.ts`](../apps/admin-cms/src/components/admin-shell/navigation.ts)
- Test: [`apps/admin-cms/src/components/admin-shell/navigation.test.ts`](../apps/admin-cms/src/components/admin-shell/navigation.test.ts)

To update project review route handling:
- Source: [`apps/admin-cms/src/app/api/projects/[publicId]/review-action/route.ts`](../apps/admin-cms/src/app/api/projects/[publicId]/review-action/route.ts)

To add a database migration:
- Migrations directory: [`infra/supabase/migrations/`](../infra/supabase/migrations/) (new 14-digit timestamped `.sql` file)

---

## 6. Making a Small Change

Edit only the specific file(s) required for your assigned issue.

*Example (updating navigation route descriptors in `apps/admin-cms/src/components/admin-shell/navigation.ts`):*
Modify or extend a route descriptor as specified by your issue.

Do not edit unrelated files, surrounding formatting, or unrelated comments.

---

## 7. Locating & Running Nearby Tests

Tests in `apps/admin-cms` are located alongside component/logic files or inside `src/security/`:
- UI and logic tests end with `.test.ts` or `.test.tsx`.

Run targeted tests while developing using Vitest from the repository root:

```bash
npm run test:run --workspace=apps/admin-cms -- src/components/admin-shell/navigation.test.ts
```

---

## 8. Adding or Updating a Test

Add a targeted assertion to an existing `.test.ts` file or create a new test alongside your code change. Re-run your targeted test command to verify it passes.

---

## 9. Running Full Repository Validation

Before staging files or creating a commit, run the full canonical verification suite (note: Docker must remain running):

```bash
npm run verify:all
```

All quality gates (onboarding precheck, feed schema check, lint, tests, typecheck, Next.js build, markdown links, terminology check, and diff checks) must pass cleanly.

---

## 10. Inspecting the Staged Diff & Checking for Credentials

Inspect your uncommitted diff and staged diff:

```bash
git diff
git diff --check
```

After staging explicit files, verify your staged diff:

```bash
git diff --cached
```

Ensure no local credential files (`.env.local`, `.local-users.json`) or real user identity values are staged.

---

## 11. Staging Explicit Files Only

**NEVER use `git add .` or `git add -A`.** Always stage explicit file paths:

```bash
git add apps/admin-cms/src/components/admin-shell/navigation.ts apps/admin-cms/src/components/admin-shell/navigation.test.ts
```

Verify staged files:

```bash
git status --short
```

---

## 12. Committing Changes

Commit using a clear, conventional message (`type(scope): description`):

```bash
git commit -m "fix(nav): update route descriptor for admin settings"
```

---

## 13. Pushing Your Branch & Waiting for CI

Push your feature branch to GitHub:

```bash
git push origin fix/admin-nav-descriptor
```

**Do not use `--force` or force-push.**

After pushing:
1. Open a Pull Request targeting `main`.
2. Fill out all sections of `.github/PULL_REQUEST_TEMPLATE.md`.
3. Wait for GitHub Actions PR CI checks (`Static Quality & Build Gates` and `Disposable Local Supabase Integration`) to complete.
4. **Do not merge the PR yourself.** Request review from a maintainer (`@acmis1`).

---

## 14. Responding to Review Comments

If a reviewer requests changes:
1. Make the requested edits on your feature branch.
2. Re-run `npm run verify:all`.
3. Stage explicit files and commit: `git commit -m "fix(nav): address reviewer feedback"`
4. Push to origin: `git push origin fix/admin-nav-descriptor`. The PR updates automatically.

---

## 15. Stopping Local Services

When finished with development, cleanly stop local Supabase containers:

```bash
npm run supabase:stop
```

---

## 16. What Must NEVER Be Included

- ❌ Real participant, staff, or supervisor personal data (PII).
- ❌ Hardcoded API keys, passwords, secrets, or connection strings.
- ❌ Modified migrations `0001` through `0008`.
- ❌ Files inside `Prototype/` (except documentation links outside `Prototype/`).
- ❌ Hosted environment credentials (`.env.local` or `.local-users.json`).
