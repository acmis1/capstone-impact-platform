# Developer Start Guide (`START_HERE.md`)

Welcome to the Capstone Impact Platform repository (`acmis1/capstone-impact-platform`). This guide provides a self-service onboarding path intended to minimize maintainer assistance for developers.

> [!NOTE]
> **Verification status**: Automated onboarding acceptance is complete (`AUTOMATED_ONBOARDING_COMPLETE`). Automated Windows clean-clone acceptance has passed (`AUTOMATED_ONBOARDING_VERIFIED`). Ubuntu 24.04 GitHub Actions integration acceptance has passed (`AUTOMATED_ONBOARDING_VERIFIED`). No independent human onboarding trial was performed (`HUMAN_ONBOARDING_NOT_PERFORMED`). Native macOS onboarding remains unverified beyond static CI contracts. Native developer-machine Linux onboarding remains unverified beyond Ubuntu CI. No hosted project credentials, private dashboards, or shared remote application environments are required for normal local development.

---

## 1. Project Purpose

The Capstone Impact Platform is a school-owned administrative CMS and publication pipeline. It collects project participant submissions, validates project metadata and poster assets, provides staff review workflows, and compiles approved project records into a stable public JSON showcase feed.

- **Active Application Code**: [`apps/admin-cms/`](./apps/admin-cms/) — The modern Next.js 16 application containing the admin dashboard, review APIs, schema validators, and public feed compiler.
- **Active Database Infrastructure**: [`infra/supabase/`](./infra/supabase/) — PostgreSQL migrations, seed SQL, and local development runbooks.
- **Active Documentation & Contributor Automation**: Root files (`README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `START_HERE.md`), [`docs/`](./docs/), and [`.github/`](./.github/) may also change during active development.
- **Historical Prototype Warning**: The [`Prototype/`](./Prototype/) folder at the root contains legacy feasibility code and demo pages. **Do not modify files in `Prototype/` or add new features there.**

---

## 2. Recommended Reading Order

1. **[`START_HERE.md`](./START_HERE.md)** (This document) — Essential setup, daily commands, and guidelines.
2. **[`first-contribution.md`](./docs/first-contribution.md)** — Step-by-step walkthrough for your first local contribution.
3. **[`onboarding-acceptance-checklist.md`](./docs/onboarding-acceptance-checklist.md)** — Human onboarding checklist for evaluating repository setup.
4. **[`onboarding-verification-matrix.md`](./docs/onboarding-verification-matrix.md)** — Multi-platform verification coverage and automated status matrix.
5. **[`README.md`](./README.md)** — Project overview and architecture summary.
5. **[`CONTRIBUTING.md`](./CONTRIBUTING.md)** — Repository workflow rules, safety boundaries, and definition of done.
6. **[`apps/admin-cms/README.md`](./apps/admin-cms/README.md)** — Developer guide for the Next.js application, routes, and components.
7. **[`infra/supabase/local-development.md`](./infra/supabase/local-development.md)** — Local database architecture, migrations, and local verification details.
8. **[`docs/developer-troubleshooting.md`](./docs/developer-troubleshooting.md)** — Fixes for common setup errors.

---

## 3. Prerequisite Installation & Toolchain Guidance

Before running the application, verify your toolchain:

1. **Node.js**: Requires `Node >= 24.14.1 < 25`. Pinned to `24.14.1` in `.nvmrc`. Verify with `node -v`. Use `nvm` or `nvm-windows` to switch versions if needed.
2. **npm**: Requires `npm >= 11.11.0 < 12`. Pinned in `packageManager` to `npm@11.11.0`. Verify with `npm -v`.
3. **Docker**: Docker Desktop (Windows/macOS) or Docker Engine (Linux) must be launched **before** setup. Verify Docker daemon is active with `docker ps`. Initial setup will automatically download required Supabase Docker images, which may take several minutes on first run. Docker must remain running while executing local commands or `npm run verify:all`.
4. **Supabase CLI**: Installed locally as a repository devDependency (`supabase@2.109.1`) via `npm ci`. You do **not** need to install `supabase` globally or run `supabase login`.
5. **Port & Credentials Handling**: Local Supabase uses ports `54321`–`54324` and Next.js uses port `3000`. If a port is occupied, see [`docs/developer-troubleshooting.md`](./docs/developer-troubleshooting.md). Generated local synthetic credentials are stored in `apps/admin-cms/.local-users.json` (git-ignored) and must never be committed.

---

## 4. First-Day Setup (One Command)

After cloning the repository, run the single setup command from the repository root:

```bash
git clone https://github.com/acmis1/capstone-impact-platform.git
cd capstone-impact-platform
npm ci
npm run setup:local
npm run dev:admin
```

### What `npm run setup:local` Does:
1. Runs `npm run onboarding:check` (verifies Node, npm, Docker, and repository configuration).
2. Runs `npm run supabase:start` (launches local Supabase Docker containers).
3. Runs `npm run supabase:seed:buckets` (reconciles local private & public storage buckets and mock poster fixtures).
4. Runs `npm run supabase:env:local` (generates `apps/admin-cms/.env.local`).
5. Runs `npm run supabase:users:local` (reconciles synthetic local Auth accounts).
6. Runs `npm run supabase:verify:local` (verifies database grants, RLS, functions, buckets, and synthetic sign-in).

`setup:local` is safe and idempotent to rerun, and does not destroy existing database state. Use `npm run supabase:reset` separately only when intentionally rebuilding from migrations and seed data.

---

## 5. Daily Startup, Synthetic Login & Shutdown

### Starting Daily Work
```bash
# 1. Start local stack and verify environment state
npm run setup:local

# 2. Launch Next.js dev server
npm run dev:admin
```

### Logging In Locally
1. Open [`http://localhost:3000/login`](http://localhost:3000/login) in your browser.
2. Open the file `apps/admin-cms/.local-users.json` generated on your machine.
3. Use any of the synthetic staff accounts:
   - **Administrator**: `local.admin@capstone.test`
   - **Reviewer**: `local.reviewer@capstone.test`
   - **Editor**: `local.editor@capstone.test`
   - Passwords are dynamically generated in `.local-users.json` (which is git-ignored).

### Local Email Capture (Mailpit)
Local emails (password resets, invitations) are captured by local Mailpit:
- **Mailpit Web UI**: [`http://localhost:54324`](http://localhost:54324)

### Stopping Daily Work
```bash
npm run supabase:stop
```

---

## 6. Repository Directory Map

```text
capstone-impact-platform/
├── .github/                  # PR templates, issue templates, CODEOWNERS, CI workflows
├── apps/
│   └── admin-cms/            # Active Next.js 16 Admin/CMS application
│       ├── src/
│       │   ├── app/          # App Router routes (/admin, /login, /api/...)
│       │   ├── components/   # UI components & admin shell
│       │   ├── domain/       # TypeScript domain types & models
│       │   ├── repositories/ # Database repository layer & Supabase RPC callers
│       │   ├── scripts/      # Verification & setup runners
│       │   └── security/     # Security tests & validation suites
│       └── README.md         # Admin/CMS technical documentation
├── docs/                     # Technical specifications & runbooks
│   └── developer-troubleshooting.md # Developer setup troubleshooting guide
├── infra/
│   └── supabase/             # Database migrations, seed SQL, runbooks
│       └── migrations/       # 8 timestamped PostgreSQL migration files
├── Prototype/                # Legacy historical code (DO NOT MODIFY)
├── AGENTS.md                 # Agent governance & repository rules
├── CONTRIBUTING.md           # Contributor workflow & safety rules
├── README.md                 # Primary repository overview
└── START_HERE.md             # Developer onboarding and repository start guide
```

---

## 7. Common Task-to-File Map

| Task Goal | Files / Directory to Inspect |
|---|---|
| Add / modify Admin UI page | `apps/admin-cms/src/app/admin/` |
| Modify navigation / UI layout | `apps/admin-cms/src/components/admin-shell/` |
| Add / modify API endpoint | `apps/admin-cms/src/app/api/` |
| Update project review logic | `apps/admin-cms/src/app/api/projects/[publicId]/review-action/route.ts` |
| Modify database calls | `apps/admin-cms/src/repositories/SupabaseProjectRepositoryCore.ts` |
| Add database schema change | `infra/supabase/migrations/` (create new 14-digit timestamped `.sql` file) |
| Update feed compiler | `apps/admin-cms/src/feed/compilePublicFeed.ts` |
| Add unit test | `apps/admin-cms/src/**/*.test.ts` |
| Fix setup / script error | `apps/admin-cms/src/scripts/` |

---

## 8. Development & Git Lifecycle

### Branch Naming
All work must occur on narrow feature branches created from `main`:
- `docs/*` — Documentation updates (e.g. `docs/developer-self-service`)
- `feat/*` — New application features (e.g. `feat/project-editor-ui`)
- `fix/*` — Bug fixes (e.g. `fix/table-pagination-order`)
- `infra/*` — Local tooling & configuration (e.g. `infra/local-runner`)
- `security/*` — Auth, RLS, & security updates (e.g. `security/rpc-hardening`)

### Commit Workflow
1. Sync `main` before starting:
   ```bash
   git checkout main
   git pull --ff-only origin main
   ```
2. Create your branch: `git checkout -b feat/my-feature-name`
3. Stage explicit files only: **Never run `git add .` or `git add -A`**. Use `git add path/to/file1 path/to/file2`.
4. Check whitespace & diff syntax: `git diff --check`
5. Commit with descriptive messages: `git commit -m "feat(review): add filter for archived projects"`

### Keeping Your Branch Up to Date
If `main` has new commits while you are working on your branch, merge — do not rebase:
```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout feat/my-feature-name
git merge main
```

> [!WARNING]
> **Do not rebase a pushed branch unless a maintainer explicitly directs it.**
> **Do not force-push (`git push --force`) any branch. Never force-push `main`.**
> **Do not resolve migration conflicts by editing merged migrations — ask a maintainer.**

### Pull Request Workflow
1. Select an assigned GitHub Issue (1 issue per branch).
2. Run full verification before pushing: `npm run verify:all`
3. Push branch to GitHub: `git push origin feat/my-feature-name`
4. Open a Pull Request targeting `main`. Fill out all checkboxes in `.github/PULL_REQUEST_TEMPLATE.md`.
5. Self-merging is prohibited; request a review from a maintainer (`@acmis1`).

---

## 9. Required Quality & Verification Commands

Before submitting a Pull Request, run the automated verification suite:

```bash
npm run verify:all
```

### What `npm run verify:all` Checks:
1. `npm run onboarding:check` — Toolchain & environment precheck
2. `npm run check:onboarding-docs` — Onboarding documentation contract check
3. `npm run check:terminology` — Tracked current-tree terminology check
4. `npm run check:yaml` — GitHub workflow and template YAML parse check
5. `npm run check:markdown-links` — Tracked Markdown relative-link check
6. `npm run check:feed` — Public feed contract verification
7. `npm run lint --workspace=apps/admin-cms` — ESLint (must pass with 0 errors & 0 warnings)
8. `npm run test:admin` — Vitest unit and security test suite
9. `npm run typecheck:admin` — TypeScript typecheck (`tsc --noEmit`)
10. `npm run build:admin` — Next.js production build (`next build`)
11. `git diff --check` — Uncommitted working-tree whitespace check
12. `git diff --check origin/main...HEAD` — Committed branch diff whitespace check

---

## 10. Database Migration Rules

1. **Append-Only Policy**: Existing migrations `0001` through `0008` in `infra/supabase/migrations/` are merged and immutable. **Never modify, rename, or delete migrations `0001` through `0008`.**
2. **New Migrations**: If your feature requires schema, index, RLS, or function changes:
   - Create a new 14-digit timestamped file: `infra/supabase/migrations/YYYYMMDDHHMMSS_description.sql`.
   - Replay locally using `npm run supabase:reset`.
   - Add static contract tests in `apps/admin-cms/src/security/`.
3. **Local/Repo Scope**: Migrations `0007` and `0008` are repository and local-only. Hosted staging migration application is managed separately by authorized maintainers.

---

## 11. What Can I Work On? Local vs Maintainer Boundaries

A normal local contributor may work on:
- Local UI components and layout enhancements in `apps/admin-cms/`;
- Local Next.js API routes and server handlers;
- Domain validation rules and schemas;
- Repository logic and query callers;
- New local database migrations through append-only timestamped `.sql` files;
- Local authentication and role behavior;
- Synthetic package ingestion and parsing workflows;
- Local public feed compilation and schema validation;
- Unit and integration tests;
- Repository documentation and guides.

Explicit maintainer authorization is required for:
- Hosted database migration application;
- Staging environment mutations;
- Staff account provisioning outside local synthetic accounts;
- Production publication or Duda live integration;
- Duda site configuration changes;
- SMTP server credentials or email delivery setup;
- AI/OCR endpoint API keys or billing configuration;
- Account ownership, repository admin access, or hosting billing changes;
- Use of real participant or supervisor identity data;
- Incident-response or destructive operations on hosted infrastructure.

These boundaries protect institutional assets and privacy without restricting normal local feature development.

---

## 12. Starting Work from Assigned GitHub Issues

Developers should always begin implementation from an assigned GitHub issue that specifies:
- One primary outcome;
- One feature branch (`feat/*`, `fix/*`, `infra/*`, `docs/*`, `security/*`);
- Explicit acceptance criteria;
- In-scope and out-of-scope boundaries;
- Required tests and verification steps;
- Security constraints;
- Required documentation updates.

Do not select broad roadmap topics directly from `docs/implementation-backlog.md` and independently interpret them as a single implementation task. Detailed implementation issues will be created and assigned separately by maintainers after onboarding.

---

## 13. Environment Model: Local vs Staging vs Production

| Environment | Host / Location | Credentials Used | State Modifications |
|---|---|---|---|
| **Local** | `http://127.0.0.1` | Synthetic credentials in `.local-users.json` | Fully controlled via `npm run setup:local` |
| **Staging** | `capstone-admin-cms-staging-2026` | Isolated staging secrets (maintained by project owner) | Requires double-acknowledgement CLI flags (`--apply --confirm-staging=...`) |
| **Production** | Live public showcase (Duda) | Isolated production credentials | Strictly restricted; no project participant direct access |

---

## 14. Prohibited Operations

- ❌ **DO NOT** run `supabase login`, `supabase link`, `supabase db push`, `supabase db pull`, or `supabase migration repair`.
- ❌ **DO NOT** access hosted Supabase, Render, Vercel, or Duda dashboards.
- ❌ **DO NOT** hardcode or commit API keys, secrets, credentials, passwords, or connection strings.
- ❌ **DO NOT** use real participant, staff, or supervisor personal identity data (use synthetic data only).
- ❌ **DO NOT** modify files in `Prototype/`.
- ❌ **DO NOT** edit merged migrations `0001` through `0008`.
- ❌ **DO NOT** self-merge Pull Requests without maintainer sign-off.

---

## 15. Common Troubleshooting & Escalation

If you encounter issues during setup or development:
- Consult the **[Developer Troubleshooting Guide](./docs/developer-troubleshooting.md)** for step-by-step solutions to Docker, Node, port conflict, database reset, or build errors.

### Stop and Escalate Immediately If:
- Secret, credential, or API key exposure is detected.
- Merge conflicts exist that cannot be safely resolved.
- Hosted service login or private dashboard credentials are requested.
- `git status` shows unexpected modified files outside your branch scope.

---

## 16. Glossary

- **Next.js 16 (App Router)**: The React framework used for server-side rendering, routing, layouts, and API endpoints in `apps/admin-cms/`.
- **Supabase**: Open-source backend suite providing PostgreSQL database, Auth (GoTrue), and Storage (S3-compatible API).
- **Migration**: Timestamped SQL file that incrementally applies database schema updates.
- **Row-Level Security (RLS)**: PostgreSQL feature restricting which database rows a user can SELECT, INSERT, UPDATE, or DELETE based on their authenticated identity and roles.
- **Remote Procedure Call (RPC)**: A custom PostgreSQL function (`public.perform_project_review_action`) executed atomically on the database server.
- **`service_role`**: Privileged Supabase internal database role bypassing RLS, restricted exclusively to server-side code.
- **Staging**: An isolated pre-production test environment mimicking production structure.
- **Duda Feed**: The compiled public JSON artifact (`capstones-latest.json`) consumed by the external Duda showcase website.
- **Synthetic Data**: Simulated, non-real test data used for local and staging development to protect privacy.
