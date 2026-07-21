# AGENTS.md

## 1. Repository Purpose & Architecture Authority
- **Repository**: `acmis1/capstone-impact-platform`
- **Active Application Path**: `apps/admin-cms` (target structure for enterprise Admin/CMS application).
- Executable code, database migrations, strict schemas, and verified test suites take precedence over planning prose or documentation proposals.
- Preserve legacy `Prototype` root files strictly as historical evidence and reference context; keep them isolated.

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

---

### Detailed Operational Guidelines

#### Governance & Compliance
1. Codebase authority rests with executable specifications, type contracts, and verified test suites.
2. Legacy prototype files under `Prototype/` are preserved for context; active development targets `apps/admin-cms`.
3. Secret scanning must be performed prior to any git stage or commit operation.

#### Branching & Pull Requests
1. Feature branches must be spawned from up-to-date `main`.
2. PR descriptions must include explicit technical scope, verification results, and safety confirmations.
3. Untracked files and local developer configurations must never be modified or deleted automatically.

#### Verification Discipline
1. Targeted file diff and syntax checks during development.
2. Gate-level execution of unit, integration, and type checks before final PR submission.
3. Evidence-based summary logs reporting exactly what was executed and verified.

#### Security & Access Boundaries
1. No private console access (Supabase, Duda, Render) without explicit user approval.
2. No automated database schema mutations or data writes without task authorization.
3. Treat all environment variable files as immutable and sensitive.

#### 6.7 Data Integrity & Preservation
- Do not modify production database records or storage buckets directly from local scripts.
- Treat historical prototype records and schema definitions as immutable baselines.
- Ensure all migration procedures are documented, repeatable, and tested in isolated environments.

#### 6.8 Interaction with External APIs & Services
- All external API interactions (Supabase, Duda) must go through centralized service clients.
- Handle API failures gracefully with appropriate retry mechanisms and user-facing error messages.
- Ensure compliance with rate limits and quota constraints across all external service integrations.

#### 6.9 Continuous Integration & PR Quality Gates
- All PRs must pass automated linting, type-checking, and unit test suites before merge approval.
- Maintain clear commit history with descriptive commit messages following Conventional Commits.
- Include explicit verification steps in PR descriptions to facilitate peer review.

#### 6.10 Documentation & Knowledge Sharing
- Keep documentation up-to-date alongside code changes.
- Document architectural decisions, design token contracts, and API contracts clearly.
- Provide clear instructions for setup, local development, and testing procedures.

#### 6.11 Code Quality & Style Consistency
- Follow established code style guidelines and linting rules across the codebase.
- Maintain high code quality through code reviews, refactoring, and static analysis tools.
- Strive for clean, readable, and maintainable code architecture in all components.

#### 6.12 Performance & Optimization
- Optimize bundle sizes, asset loading, and server rendering performance.
- Monitor application performance metrics and address bottlenecks proactively.
- Ensure smooth user experiences with fast load times and responsive interfaces.
