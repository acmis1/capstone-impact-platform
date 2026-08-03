# Capstone Impact Platform

An enterprise platform for managing, evaluating, and showcasing academic capstone projects. Built with Next.js (App Router), Supabase (PostgreSQL, Row-Level Security, Auth, Storage), and Tailwind CSS.

---

## ⚠️ Staging Status & Environment Notice

> [!NOTE]
> * **Local Development Status:** Local Supabase development is 100% verified using Docker Desktop and pinned Supabase CLI `2.109.1`. All 7 migrations replay cleanly and pass automated local verifiers. Local setup requires **no** Supabase cloud account or organization membership.
> * **Hosted Staging Status:** Migrations `0001` through `0006` were manually applied to isolated staging (`capstone-admin-cms-staging-2026`). Migration `0007` (`20260803174000_harden_function_execute_defaults.sql`) is local/repository-only and has not yet been applied to hosted staging.
> * **Hosted Migration History:** Local migration replay is verified; hosted CLI migration reconciliation remains pending execution of the 7-gate reconciliation runbook.

---

## Canonical Prerequisites & Quick Start

All contributors must follow the [Contributor Guide](./CONTRIBUTING.md) for full developer guidelines.

### Prerequisites
- **Node.js**: `>= 24.14.1 < 25` (Pinned in `.nvmrc` as `24.14.1`; Node 24 is the maintained LTS line used for verification)
- **npm**: `>= 11.11.0 < 12` (Declared in `packageManager` as `npm@11.11.0`)
- **Docker Desktop / Engine**: Local container daemon must be active.

### Quick Start (Reproducible Local Setup)

```bash
# 1. Install dependencies cleanly
npm ci

# 2. Run automated onboarding precheck (12 checks)
npm run onboarding:check

# 3. Start local Supabase services
npm run supabase:start

# 4. Reset local database and replay all 7 migrations
npm run supabase:reset

# 5. Seed storage buckets and synthetic media fixtures
npm run supabase:seed:buckets

# 6. Generate local loopback environment file
npm run supabase:env:local

# 7. Provision local synthetic staff user credentials
npm run supabase:users:local

# 8. Run local verification suite
npm run supabase:verify:local

# 9. Start Admin/CMS dev server
npm run dev:admin
```

Clean up local containers when finished:
```bash
npm run supabase:stop
```

---

## Workspace Architecture

```text
capstone-impact-platform/
├── .nvmrc                         # Pinned Node.js version (24.14.1)
├── CONTRIBUTING.md                # Authoritative contributor guide & toolchain contract
├── README.md                      # Primary project overview and quickstart
├── package.json                   # Root package manifest (engines, scripts, CLI pin)
├── package-lock.json              # Canonical lockfile
├── apps/
│   └── admin-cms/                 # Next.js 16 Admin & Content Management System
│       ├── README.md              # Application-specific documentation
│       └── src/                   # App Router pages, components, lib, scripts
├── infra/
│   └── supabase/                  # Database migrations & local environment tools
│       ├── README.md              # Supabase infrastructure overview
│       ├── local-development.md   # Detailed local setup and verification log
│       └── migrations/            # Version-controlled SQL schema migrations (0001 - 0007)
├── docs/                          # Platform architecture and integration specs
└── Prototype/                     # Historical reference (read-only isolate)
```

---

## Verification & Quality Gates

Run these commands prior to submitting any pull request:

```bash
npm run onboarding:check
npm run check:feed
npm run lint --workspace=apps/admin-cms
npm run test:admin
npm run typecheck:admin
npm run build:admin
git diff --check
```

---

## Documentation Map

- **[Contributor Guide](./CONTRIBUTING.md)**: Developer onboarding, toolchain contract, git rules, security boundaries.
- **[Local Development Guide](./infra/supabase/local-development.md)**: Comprehensive local setup instructions, seed fixtures, and empirical verification log.
- **[Supabase Infrastructure](./infra/supabase/README.md)**: Migration inventory, staging status, and database operational governance.
- **[Admin/CMS App Guide](./apps/admin-cms/README.md)**: Application structure, component layout, and environment variable configuration.
