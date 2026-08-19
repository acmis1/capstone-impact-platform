# Developer Onboarding Acceptance Checklist (`docs/onboarding-acceptance-checklist.md`)

This human onboarding acceptance checklist is designed for a new developer or external tester evaluating the self-service developer setup of the Capstone Impact Platform (`acmis1/capstone-impact-platform`).

> [!NOTE]
> **Verification Status**: Automated onboarding acceptance is complete (`AUTOMATED_ONBOARDING_COMPLETE`). Automated Windows acceptance has passed (`AUTOMATED_ONBOARDING_VERIFIED`). Ubuntu 24.04 GitHub Actions integration has passed (`AUTOMATED_ONBOARDING_VERIFIED`). Native macOS corrective verification passed on the recorded local checkout after the loopback-binding fix; it was not an independent fresh-clone human trial (`HUMAN_ONBOARDING_NOT_PERFORMED`). Native developer Linux onboarding remains unverified beyond CI contracts. This checklist establishes the evaluation criteria if an independent human verification run is conducted.

---

## 1. Environment Details

Please record your local system parameters:

- **Tester Name / Handle**: ____________________
- **Date**: ____________________
- **Operating System**: [ ] Windows 11 / 10  |  [ ] macOS  |  [ ] Linux (Distro: ________)
- **Node.js Version** (`node -v`): ____________________ *(Expected: v24.14.1)*
- **npm Version** (`npm -v`): ____________________ *(Expected: 11.11.0 or >=11.11.0 <12)*
- **Docker Engine / Desktop Version** (`docker -v`): ____________________
- **Available System Memory (RAM)**: ____________________ GB
- **Was Manual Maintainer Assistance Required?**: [ ] Yes  |  [ ] No

---

## 2. Setup Acceptance Workflow

Follow `START_HERE.md` from top to bottom and mark each step:

- [ ] **Repository Clone**: Successfully cloned `https://github.com/acmis1/capstone-impact-platform.git`.
- [ ] **Dependency Installation**: Executed `npm ci` without errors.
- [ ] **Automated Onboarding Precheck**: `npm run onboarding:check` passed all 12 checks.
- [ ] **Local Stack Startup & Setup**: Executed `npm run setup:local` without errors.
- [ ] **Supabase Host-Binding Isolation**: Confirmed every published local Supabase port (`54321`–`54327`) is bound to loopback only, with no `0.0.0.0` or `::` publication.
- [ ] **Synthetic Account Generation**: Verified `apps/admin-cms/.local-users.json` was generated.
- [ ] **Local Server Startup**: `npm run dev:admin` launched Next.js on `127.0.0.1:3000`; `http://localhost:3000` remained reachable.
- [ ] **Local Login Acceptance**: Signed in at `http://localhost:3000/login` using synthetic `local.admin@capstone.test` credentials.
- [ ] **Dashboard Navigation**: Accessed `/admin` dashboard and verified project index loaded.
- [ ] **Project Listing & Filter Check**: Verified status and program filters function without UI errors.
- [ ] **Idempotent Setup Rerun**: Stopped server and reran `npm run setup:local`. Confirmed process succeeded without destroying local database state.
- [ ] **Full Repository Verification**: Executed `npm run verify:all`. Confirmed all quality gates passed.
- [ ] **Clean Stack Shutdown**: Executed `npm run supabase:stop`. Confirmed containers stopped cleanly.

---

## 3. Architecture & Governance Comprehension Checks

Verify your understanding of key repository conventions:

1. **Active Application Directory**: Which folder contains the active Next.js application?
   - [ ] `apps/admin-cms/` *(Correct)*
   - [ ] `Prototype/`

2. **Historical Prototype Directory**: Which folder is historical feasibility evidence and must NOT be edited for new features?
   - [ ] `Prototype/` *(Correct)*
   - [ ] `apps/admin-cms/`

3. **Database Migrations Location**: Where do version-controlled database migrations live?
   - [ ] `infra/supabase/migrations/` *(Correct)*
   - [ ] `apps/admin-cms/src/db/`

4. **API Route Handlers Location**: Where do Next.js server API routes live?
   - [ ] `apps/admin-cms/src/app/api/` *(Correct)*
   - [ ] `infra/supabase/api/`

5. **Repository / Database Layer**: Where are Supabase database queries and RPC calls implemented?
   - [ ] `apps/admin-cms/src/repositories/` *(Correct)*
   - [ ] `apps/admin-cms/src/app/admin/`

6. **Unit & Security Tests Location**: Where do Vitest test files live?
   - [ ] Alongside components (`*.test.ts`) and in `apps/admin-cms/src/security/` *(Correct)*
   - [ ] In `Prototype/tests/`

7. **Destructive Database Command**: Which command destroys local database state to replay migrations from scratch?
   - [ ] `npm run supabase:reset` *(Correct)*
   - [ ] `npm run setup:local`

8. **Maintainer Authorization Boundary**: Which actions require explicit maintainer authorization?
   - [ ] Hosted staging/production database mutations, cloud credentials, Duda changes, real user data *(Correct)*
   - [ ] Local UI edits, local tests, running `npm run setup:local`

---

## 4. First-Contribution Simulation

Verify that you can explain the required PR lifecycle (refer to `docs/first-contribution.md`):

- [ ] Can explain how to update `main` before starting a feature branch.
- [ ] Can state why `git add .` or `git add -A` is prohibited (must stage explicit files only).
- [ ] Can state why force-pushing (`git push --force`) is prohibited.
- [ ] Can list the commands executed by `npm run verify:all`.
- [ ] Can identify when to stop local work and escalate to the project maintainer.

---

## 5. Empirical Tester Evidence & Feedback

Record any anomalies or timing metrics during your test:

- **Total Setup Time (minutes)**: ____________________
- **Failed Commands (if any)**: ____________________
- **Confusing / Unclear Instructions**: ____________________
- **Undocumented Prerequisites**: ____________________
- **Broken Links Encountered**: ____________________
- **Places Where Verbal Assistance Was Required**: ____________________

*Submit completed checklists to the project maintainer via GitHub issue or discussion.*
