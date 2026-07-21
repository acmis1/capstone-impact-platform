# AGENTS.md

## 1. Repository Purpose & Architecture Authority
- **Repository**: `acmis1/capstone-impact-platform`
- **Authoritative Application Path**: `apps/admin-cms` (target structure for enterprise Admin/CMS application).
- Executable code, automated test suites, and strict schemas take precedence over planning prose or documentation proposals.
- Preserve legacy `Prototype` root files strictly as historical evidence and reference context.

## 2. Operational Rules & Environment Safety
- **Secrets & Credentials**: Never hardcode, expose, log, or commit secrets, tokens, API keys, private database connection strings, user credentials, real identity values, or environment variable contents.
- **Private Operations**: No private Supabase, Duda, or external dashboard operations by coding agents.
- **Database & Storage Writes**: No database, Auth, or Storage write operations without explicit user approval.
- **Environment Integrity**: Preserve all untracked files, local worktree configurations, and active git branches.
- **Workflow & Change Scope**: Use isolated feature branches (`docs/*`, `feat/*`, `fix/*`) and submit clean, reviewable Pull Requests. Avoid broad or unrelated refactors. Prefer minimal, surgical, and coherent diffs.

## 3. Execution & Validation Strategy
- Use targeted checks during active iteration.
- Execute full validation suites (builds, tests, linting) at code PR submission gates.
- Documentation-only tasks do not require application builds unless explicit documentation tests exist.

## 4. Stop Conditions
Halt execution immediately with clear error reporting if:
- Local git repository state is dirty, conflicted, or out of sync with target upstream branches.
- Exposed secrets, tokens, or private credentials are detected in diffs or workspace outputs.
- An operation requires unsupported private dashboard or administrative database access without user approval.

## 5. Reporting Standards
- All task summaries and progress reports must be concise, structured, direct, evidence-based, and state remaining risks clearly.

---

### 6. Architectural Principles & Guidelines

#### 6.1 Codebase Authority & Heritage
- Codebase authority rests with executable specifications, type contracts, and verified test suites.
- Legacy prototype files under `Prototype/` are preserved for historical context and visual baseline reference.
- Active feature implementation strictly targets `apps/admin-cms`.

#### 6.2 Security & Secret Governance
- Secret scanning must be performed prior to any git stage or commit operation.
- No production access tokens, private database strings, or service role credentials in code or diffs.
- Autonomous agents must halt if credentials or tokens are exposed.

#### 6.3 Branching, Worktrees & Pull Requests
- Feature branches must be spawned directly from up-to-date `main`.
- Pull Request descriptions must include technical scope, industry pattern references, validation results, and safety confirmations.
- Untracked files and local developer configurations must never be modified or deleted automatically.

#### 6.4 Verification Discipline & Quality Control
- Targeted file diff and syntax checks during development.
- Gate-level execution of unit, integration, and type checks before final PR submission.
- Evidence-based summary logs reporting exactly what was executed and verified.
- Avoid unnecessary full builds during documentation or specification editing phases.

#### 6.5 Change Scope & Minimization
- Keep pull requests narrow, surgical, and focused on specific operational outcomes.
- Avoid broad formatting refactors or style updates to untouched code files.
- Ensure every proposed change has an explicit justification tied to project requirements.

#### 6.6 Agent Stop Conditions & Operational Boundaries
- Stop if git status indicates untracked conflicts or modified staging branch mismatches.
- Stop if private console access (Supabase, Duda, Render) is requested without authorization.
- Stop if schema mutations or data writes are attempted without approval.

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
