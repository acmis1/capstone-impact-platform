# Capstone Impact Platform Documentation Index

This directory contains the authoritative root-level project documentation.

## Documentation Precedence Registry

When verifying system behavior or planning extensions, information must be referenced in the following order of precedence:

1. **Executable Implementation**: Executable code, PostgreSQL schema migrations, and automated unit/integration test suites on the `main` branch define the absolute source of truth for current implemented behavior.
2. **Root Documentation**: General cross-system architecture, operational constraints, security guidelines, and delivery backlog records reside in this `/docs` directory.
3. **Admin CMS Foundation**: Application-specific staging configurations, environment variables, local testing scripts, and directory structures reside in [apps/admin-cms/README.md](../apps/admin-cms/README.md).
4. **Feasibility Prototype**: Legacy prototype operations, recovery scripts, local dry-run configurations, and recovery execution steps reside in [Prototype/docs/supabase-recovery-runbook.md](../Prototype/docs/supabase-recovery-runbook.md) and [Prototype/docs/deployment-staging.md](../Prototype/docs/deployment-staging.md).
5. **Historical Reference**: The `break/docs-foundation` branch serves purely as a historical input from early planning phases and must not be referenced as the current operational source of truth.

---

## Master Document Directory

*   **[Project Architecture & Constraints](project-architecture-and-constraints.md)**: Overall system blueprint, data publication flows, and immutable platform boundaries (e.g., Duda upgrade limitations and environment isolation).
*   **[Public Feed Contract](public-feed-contract.md)**: Formal schema definition, validator fields, compiler defaults, and visual layout config definitions for the public JSON payload (`capstones-latest.json`).
*   **[Security & Maintainability Plan](security-and-maintainability-plan.md)**: Trust boundaries, authentication foundations, media file isolation, and long-term project maintainability principles.
*   **[Implementation Backlog](implementation-backlog.md)**: Priority-ranked backlog of planned functional modules, student confirmation workflows, AI/OCR assist integrations, and handover criteria.

---

## Documentation Update Rules

*   **Continuous Synchronization**: Root-level documentation must be updated immediately whenever implemented behavior, deployment status, credentials ownership, or mandatory stakeholder requirements change.
*   **Stale Branch Prohibition**: Stale planning or architecture draft branches must never be merged directly into `main`. All updates must go through a consolidated rewrite branch to preserve alignment with the codebase.
