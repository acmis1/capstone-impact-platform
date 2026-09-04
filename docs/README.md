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

*   **[First Contribution Guide](first-contribution.md)**: Beginner-safe step-by-step local contribution walkthrough for an assigned task.
*   **[Onboarding Acceptance Checklist](onboarding-acceptance-checklist.md)**: Human onboarding acceptance checklist and comprehension verification.
*   **[Onboarding Verification Matrix](onboarding-verification-matrix.md)**: Empirical verification matrix across Windows local host, Ubuntu 24.04 CI, and macOS CI.
*   **[Project Architecture & Constraints](project-architecture-and-constraints.md)**: Overall system blueprint, data publication flows, and immutable platform boundaries (e.g., Duda upgrade limitations and environment isolation).
*   **[Public Feed Contract](public-feed-contract.md)**: Formal schema definition, validator fields, compiler defaults, and visual layout config definitions for the public JSON payload (`capstones-latest.json`).
*   **[Media Capability Matrix & Controlled-Link Audit](media-capability-matrix.md)**: Authoritative implementation-status matrix for poster image/PDF, gallery media, controlled video/demo/repository URLs, participant-preview boundaries, publication behavior, and the `video_link` future-only boundary.
*   **[Security & Maintainability Plan](security-and-maintainability-plan.md)**: Trust boundaries, authentication foundations, media file isolation, and long-term project maintainability principles.
*   **[Implementation Backlog](implementation-backlog.md)**: Priority-ranked backlog of planned functional modules, participant confirmation workflows, AI/OCR assist integrations, and handover criteria.
*   **[M6 Operational Readiness & Recovery](m6-operational-readiness.md)**: Current gap matrix, repository evidence command, backup/restore scope, RPO/RTO, monitoring, incident, and Render redeploy/rollback contracts.
*   **[M6 Release Acceptance Checklist](m6-release-acceptance-checklist.md)**: Canonical evidence-indexed acceptance gate for source, database, application, workflow, security, recovery, monitoring, documentation, and handover.
*   **[Admin/CMS Operator Guide](admin-operator-guide.md)**: Routine staff operations, controlled failure handling, authority boundaries, and escalation guidance.
*   **[Developer Handover Guide](developer-handover-guide.md)**: Source-of-truth, maintenance map, local setup, migrations, release evaluation, deployment, and recovery boundaries.
*   **[Operational Ownership & Training](operational-handover-and-training.md)**: Role ownership matrix, credential-policy transfer record, escalation acceptance, and KPI-15 unaided routine-task instrument.
*   **[Integrated Release Evaluation Harness](release-evaluation-harness.md)**: Disposable-Local 132-case evaluation, evidence boundaries, cleanup, repeatability, and report interpretation.
*   **[Manual Efficiency Template](templates/release-evaluation-manual-efficiency.md)**: Unfilled comparison template for later staff-effort measurement.

---

## School Handover Package

*   **[START HERE — School Handover and Operations](handover/README.md)**: The single entry point for a new School owner or technical maintainer. Read this before anything else in this section.
*   **[Resource Ownership & Transfer Matrix](handover/resource-ownership-matrix.md)**: Every external resource, who owns it today, who must own it finally, and the exact transfer or redeployment procedure. Complements the role matrix above.
*   **[Environment Matrix](handover/environment-matrix.md)**: Local, disposable test, staging, and School operational environments, with the isolation rules and configuration that separate them.
*   **[Third-Party Provider Licences](handover/third-party-licences.md)**: What the assistive worker image contains and what must be settled before it is published anywhere public.
*   **[Architecture Decision Log](architecture-decision-log.md)**: Final architectural decisions and their reasoning, so no future maintainer needs anyone's memory or chat history.

---

## Zero-Cost Operations

*   **[Zero-Cost Assistive Executor](operations/zero-cost-assistive-executor.md)**: Both supported assistive execution profiles, the database-enforced launch ceiling, deployment, day-to-day operation, the failure table, and an honest statement of what the zero-cost profile does not promise.
*   **[Free-Tier Capacity & Handover](operations/free-tier-capacity-and-handover.md)**: Every free-tier dependency with verified limits and sources, exhaustion behaviour, monitoring, cost-avoidance rules, and the periodic provider-terms review procedure.
*   **[Executor Infrastructure Template](../infra/azure/assistive-executor/README.md)**: What the executor infrastructure creates, what it deliberately omits, and how to deploy it.

---

## Infrastructure & Operational Runbooks

*   **[Local Supabase Development Guide](../infra/supabase/local-development.md)**: Reproducible local Supabase setup via Docker and CLI 2.109.1 (Windows with Docker Desktop verified; macOS, Linux, and independent human onboarding pending).
*   **[System Recovery Readiness Runbook](system-recovery-readiness.md)**: Non-destructive disposable-Local database and Storage backup/restore drill, post-recovery smoke checks, state-preservation rules, and hosted recovery boundaries.
*   **[Staging Migration Reconciliation Runbook](../infra/supabase/staging-reconciliation-runbook.md)**: 7-gate runbook for verifying, backing up, reconciling, and auditing hosted Supabase database migrations.
*   **[Staging Migrations 0049–0051 Rollout Plan](operations/staging-migrations-49-51-rollout.md)**: Release-specific packet for the hosted 48 → 51 transition: source state, per-migration effects, read-only gates, the pre-migration recovery-capture precondition, apply and deployment order, and post-migration verification. Authorizes no mutation.
*   **[Key Migration Governance](../infra/supabase/key-migration-governance.md)**: Standards for modern server secret key preference (`SUPABASE_SECRET_KEY`) and secret rotation policies.
*   **[Staff Lifecycle Design](../infra/supabase/staff-lifecycle-design.md)**: Staff account provisioning, role updates, offboarding procedures, and audit attribution.
*   **[Staging Auth Verification](../infra/supabase/staging-auth-verification.md)**: Controlled authentication and authorization verification runbook.

---

## Documentation Update Rules

*   **Continuous Synchronization**: Root-level documentation must be updated immediately whenever implemented behavior, deployment status, credentials ownership, or mandatory stakeholder requirements change.
*   **Stale Branch Prohibition**: Stale planning or architecture draft branches must never be merged directly into `main`. All updates must go through a consolidated rewrite branch to preserve alignment with the codebase.
