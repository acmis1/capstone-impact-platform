# AGENTS.md

## 1. Repository Purpose & Architecture Authority
- **Repository**: `acmis1/capstone-impact-platform`
- **Active Application Path**: `apps/admin-cms` (target structure for enterprise Admin/CMS application).
- Executable code, database migrations, strict schemas, and verified test suites take precedence over planning prose or documentation proposals.
- Preserve legacy `Prototype/` root files strictly as historical evidence and reference context; keep them isolated.

## 2. Security, Credentials & Operational Governance
- **Secrets & Credentials**: Never expose, hardcode, log, or commit credentials, secrets, tokens, API keys, private database connection strings, user identity values, UUIDs, invitation tokens, private URLs, or environment variable contents.
- **Dashboard Access Policy**: Autonomous coding agents must not access private Supabase, Duda, Render, or other administrative dashboards.
- **Database & Services Protection**: Database, Auth, Storage, or Duda writes require explicit task authorization. Explicit authorization applies strictly to the named operation and environment.

## 3. Workflow, Change Scope & Environment Integrity
- **Environment Integrity**: Preserve all untracked files, local worktree configurations, and unrelated active git branches.
- **Branching & Pull Requests**: Use narrow, isolated feature branches (`docs/*`, `feat/*`, `fix/*`) and submit clean, reviewable Pull Requests.
- **Minimal Diffs**: Avoid broad or unrelated refactors and broad formatting changes. Inspect named files before running broad workspace searches.

## 4. Execution & Stage-Gated Validation Strategy
- Use targeted checks during active implementation.
- Run full validation suites only at code PR gates using canonical validation commands:
  - `npm run test:admin`
  - `npm run typecheck:admin`
  - `npm run build:admin`
  - `npm run lint --workspace=apps/admin-cms`
  - `git diff --check`
- Documentation-only changes normally require only `git diff --check` and consistency checks.

## 5. Agent Stop Conditions & Operational Boundaries
Stop and report immediately if:
- Unexpected tracked or staged modifications occur;
- Merge conflicts exist;
- Unexpected changes to the recorded untracked baseline occur;
- Secret or credential exposure is detected;
- Unsupported private dashboard access is requested;
- Required destructive actions lack explicit prior authorization.

## 6. Reporting Standards
- All task summaries and progress reports must be concise, direct, structured, and strictly backed by empirical execution evidence.
