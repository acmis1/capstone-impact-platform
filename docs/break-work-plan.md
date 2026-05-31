# Break Work Plan

This document outlines a safe, low-risk, and completely reversible weekly plan for the academic break period (June 2026). All planned tasks are strictly limited to documentation, codebase audits, development scaffolding, and educational preparation.

---

## Break Period Objectives
1.  **Zero Disruption**: No changes to live environments, active configurations, staging servers, or Duda layouts. **No Duda-facing changes should be made during the break; current Duda prototype evidence must be preserved and reconfirmed in July.**
2.  **Audit Readiness**: Analyze Prototype v2 (feasibility evidence only) for technical debt and security weaknesses.
3.  **Foundation Prep**: Write standard mock data, schemas, and test specs for Part 2 without changing current code behavior. All break work is strictly reversible and free-tier first.

---

## Weekly Schedule

### Week 1: Documentation Consolidation & Initial Workspace Setup
*   **Focus**: Clean up and align repository documentation.
*   **Tasks**:
    *   Initialize `/docs/` at the root as the master documentation registry.
    *   Perform a comparison of documentation in `/docs` vs `/Prototype/docs`.
    *   Create `working.md`, `constraints.md`, `decisions.md`, `prototype-audit.md`, and `open-questions.md`.
    *   Verify that no files inside `/Prototype/docs` are deleted or modified.
*   **Reversibility**: Extremely high (documentation only; can be completely rolled back via Git).

### Week 2: Prototype Codebase Audit & Security Mapping
*   **Focus**: Thoroughly audit the code structure of Prototype v2.
*   **Tasks**:
    *   Inspect `Prototype/server.js` and map out all backend routes and API inputs.
    *   Analyze `Prototype/src/App.jsx` to trace state changes, upload actions, and form inputs.
    *   Identify potential security vulnerabilities (e.g., path traversal checks, lack of route auth, missing RLS in Supabase).
    *   Document all findings inside the `/docs/prototype-audit.md` file.
*   **Reversibility**: 100% (Read-only analysis; no code changes allowed).

### Week 3: Schema Design & Mock Generation
*   **Focus**: Design the unified JSON schema and populate safe local test cases.
*   **Tasks**:
    *   Write a formalized JSON Schema (`.json` file) for the Capstone feed, outlining all 19 required fields.
    *   Create clean, dummy project packages (folder structures with sample images, mock PDF posters, and diverse Excel sheets) under the local `scratch/` or `data/` directories to test boundary cases in Part 2.
    *   Ensure all mock names, images, and data are entirely fictional to protect student privacy.
*   **Reversibility**: High (adding file mocks to local directories that are ignored or easily deleted).

### Week 4: Automated Testing Scaffolding
*   **Focus**: Establish a testing baseline using Jest/Mocha or Playwright specs.
*   **Tasks**:
    *   Draft isolated unit test specifications (`*.test.js`) for the Excel parser and the validator engine without connecting to Supabase or running them against production APIs.
    *   Write basic Playwright test scripts to simulate navigating the listing and detail pages locally in headless mode.
    *   Ensure all tests are run on a local offline mock server only.
*   **Reversibility**: High (test scripts reside in a dedicated `tests/` directory and can be ignored or deleted).

---

## Prohibited Actions during the Break
> [!CAUTION]
> **Strict Operational Boundaries**
> *   **Do NOT** run Duda site upgrades or template adjustments. (Duda upgrades are permanently out of scope).
> *   **Do NOT** replace the Duda public showcase with alternative CMS platforms.
> *   **Do NOT** alter, upgrade, or add environment variables in `.env` or staging settings.
> *   **Do NOT** change table structures, Row-Level Security, or keys in the active Supabase dashboard.
> *   **Do NOT** deploy code to production or staging services. Staging hosting will be a free-tier hosting option to be verified later.
> *   **Do NOT** present visual layout adjustments or form changes to active stakeholders.
