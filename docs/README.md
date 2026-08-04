# Capstone Impact Platform Documentation Index

This directory contains the authoritative root-level project documentation.

## Documentation Precedence Registry

When verifying system behavior or planning extensions, information must be referenced in the following order of precedence:

1. **Executable Implementation**: Executable code, PostgreSQL schema migrations, and automated unit/integration test suites on the `main` branch define the absolute source of truth for current implemented behavior.
2. **Root Documentation**: General cross-system architecture, operational constraints, security guidelines, and delivery backlog records reside in this `/docs` directory.
3. **Admin CMS Foundation**: Application-specific staging configurations, environment variables, local testing scripts, and directory structures reside in [apps/admin-cms/README.md](../apps/admin-cms/README.md).
4. **Infrastructure & Governance**: Local development guide, staging migration reconciliation runbook, key governance, and staff lifecycle design reside under [infra/supabase/](../infra/supabase/).
5. **Feasibility Prototype**: Legacy prototype operations, recovery scripts, local dry-run configurations, and recovery execution steps reside in [Prototype/docs/supabase-recovery-runbook.md](../Prototype/docs/supabase-recovery-runbook.md) and [Prototype/docs/deployment-staging.md](../Prototype/docs/deployment-staging.md).
6. **Historical Reference**: The pre-consolidation planning snapshot is permanently preserved under the annotated tag `archive-docs-foundation-2026-07-18`. This tag points to the historical documentation foundation that preceded the PR #12 consolidated rewrite, serves purely as historical evidence, and must not be referenced or treated as current operational guidance.

---

## Master Document Directory

*   **[Project Architecture & Constraints](project-architecture-and-constraints.md)**: Overall system blueprint, data publication flows, and immutable platform boundaries (e.g., Duda upgrade limitations and environment isolation).
*   **[Public Feed Contract](public-feed-contract.md)**: Formal schema definition, validator fields, compiler defaults, and visual layout config definitions for the public JSON payload (`capstones-latest.json`).
*   **[Security & Maintainability Plan](security-and-maintainability-plan.md)**: Trust boundaries, authentication foundations, media file isolation, and long-term project maintainability principles.
*   **[Implementation Backlog](implementation-backlog.md)**: Priority-ranked backlog of planned functional modules, participant confirmation workflows, AI/OCR assist integrations, and handover criteria.

---

## Infrastructure & Operational Runbooks

*   **[Local Supabase Development Guide](../infra/supabase/local-development.md)**: Reproducible local Supabase setup via Docker and CLI 2.109.1 (Windows with Docker Desktop verified; macOS, Linux, and independent human onboarding pending).
*   **[Staging Migration Reconciliation Runbook](../infra/supabase/staging-reconciliation-runbook.md)**: 7-gate runbook for verifying, backing up, reconciling, and auditing hosted Supabase database migrations.
*   **[Key Migration Governance](../infra/supabase/key-migration-governance.md)**: Standards for modern server secret key preference (`SUPABASE_SECRET_KEY`) and secret rotation policies.
*   **[Staff Lifecycle Design](../infra/supabase/staff-lifecycle-design.md)**: Staff account provisioning, role updates, offboarding procedures, and audit attribution.
*   **[Staging Auth Verification](../infra/supabase/staging-auth-verification.md)**: Controlled authentication and authorization verification runbook.

---

## Documentation Update Rules

*   **Continuous Synchronization**: Root-level documentation must be updated immediately whenever implemented behavior, deployment status, credentials ownership, or mandatory stakeholder requirements change.
*   **Stale Branch Prohibition**: Stale planning or architecture draft branches must never be merged directly into `main`. All updates must go through a consolidated rewrite branch to preserve alignment with the codebase.
