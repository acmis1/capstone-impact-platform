# START HERE — School Handover and Operations

**STATUS:** Current — handover entry point
**PURPOSE:** Operations
**LAST VERIFIED:** 2026-08-28

If you have just been given responsibility for the Capstone Impact Platform, start here. This page
is the map: it tells you what the system is, which document answers which question, and what still
has to happen before handover is complete.

You should not need anyone from the original project team, and you should not need any AI
assistant's conversation history. Everything is in this repository. If something is missing, that is
a defect — please raise it.

---

## 1. What the platform does

School staff import project-team-authored capstone packages and review the validated content.
Project teams provide complete corrected packages when needed; staff accept exact revisions and
approve them, participants confirm the resulting preview, and approved projects are
compiled into a stable JSON feed that the public Duda showcase consumes. It replaces manual email,
spreadsheet, and page-building work.

```text
participant package → staff import and review → staff approval → participant preview
  → participant correction package if needed → staff acceptance and reapproval → corrected preview
  → participant confirmation → governed publication → public feed → Duda showcase
```

Two ideas explain most of the design:

**The Admin/CMS is authoritative; the public feed is derived.** Publication is therefore reversible
and auditable, and the public site is never the only copy of anything.

**AI is assistive, never authoritative.** OCR, language checking, and duplicate detection produce
suggestions for staff. They cannot approve, publish, or silently change metadata, and the platform
works completely without them. This is why an assistive outage is never a workflow outage.

---

## 2. Pick your question

### I am School administrative staff and I need to run the system

- **[Admin/CMS Operator Guide](../admin-operator-guide.md)** — sign in, import, validation, review,
  participant previews, approval, publication, archive, and what to do when something is unavailable.

### I am the technical maintainer taking this over

Read in this order:

1. **[Developer and Technical Handover Guide](../developer-handover-guide.md)** — source-of-truth
   order, repository map, local setup, validation gates, migration discipline, deployment.
2. **[Project Architecture and Constraints](../project-architecture-and-constraints.md)** — the
   system blueprint and the boundaries that must not move.
3. **[Architecture Decision Log](../architecture-decision-log.md)** — why the system is shaped the
   way it is. Read this before proposing a change.
4. **[M6 Operational Readiness and Recovery](../m6-operational-readiness.md)** — backup and restore
   scope, recovery evidence, monitoring, incident handling, deployment and rollback.
5. **[Environment Matrix](environment-matrix.md)** — which environment may do what.

### I need to deploy, operate, or troubleshoot assistive processing

- **[Zero-Cost Assistive Executor](../operations/zero-cost-assistive-executor.md)** — both execution
  profiles, the launch ceiling, deployment, day-to-day checks, failure table, and what is *not*
  promised.
- **[Executor infrastructure template](../../infra/azure/assistive-executor/README.md)** — every
  parameter, what it deploys, and what it deliberately omits.

### I need to know what this costs and what runs out

- **[Free-Tier Capacity and Handover](../operations/free-tier-capacity-and-handover.md)** — every
  free-tier dependency, its verified limits, what happens when it is exhausted, who monitors it, and
  how to re-verify before each cycle.

### I need to deploy the Admin/CMS or reconcile the database

- **[Admin/CMS Hosted Deployment Guide](../admin-cms-hosted-deployment.md)**
- **[Staging Migration Reconciliation Runbook](../../infra/supabase/staging-reconciliation-runbook.md)**
- **[Local Supabase Development Guide](../../infra/supabase/local-development.md)**

### I need to back up, restore, or roll back

- **[System Recovery Readiness Runbook](../system-recovery-readiness.md)** — the non-destructive
  database and storage backup and restore drill.
- **[M6 Operational Readiness and Recovery](../m6-operational-readiness.md)** — recovery scope,
  measurement contract, and the deployment rollback runbook.

### I am accepting the handover on behalf of the School

- **[Resource Ownership and Transfer Matrix](resource-ownership-matrix.md)** — every external
  resource, who owns it now, who must own it finally, and the exact transfer procedure.
- **[Operational Ownership, Handover, and Training](../operational-handover-and-training.md)** —
  role ownership with primary and backup owners, the credential transfer record, and the routine-task
  training instrument.
- **[M6 Release Acceptance Checklist](../m6-release-acceptance-checklist.md)** — the evidence-indexed
  acceptance gate.

### I care about security and privacy

- **[Security and Maintainability Plan](../security-and-maintainability-plan.md)** — trust
  boundaries, media isolation, and maintainability principles.
- **[Third-Party Provider Licences](third-party-licences.md)** — what the assistive worker image
  contains, and what must be settled before publishing it anywhere public.

---

## 3. Prove it works, in about an hour

A new technical maintainer should be able to do all of this from a clean machine:

```bash
git clone <repository>
cd capstone-impact-platform
npm ci
npm run setup:local        # starts Local Supabase, seeds fixtures, generates local credentials
npm run dev:admin          # http://127.0.0.1:3000
npm run verify:all         # the full quality gate
```

Then confirm you can:

- sign in with a synthetic local account;
- see 51 migrations applied (`npm run onboarding:check`);
- build the assistive worker image (`docker build -f apps/assistive-worker/Dockerfile.hosted .`);
- run the worker locally and watch it process a queued project;
- read current executor readiness and remaining launch capacity;
- run the backup and restore drill against a disposable database;
- find the rollback procedure without asking anyone.

If any step needs knowledge that is not written down, that is the defect to fix first.

---

## 4. What this system honestly promises

Being straight about this is part of the handover.

**The application is production-quality** in security, data integrity, authorisation, concurrency,
recoverability, auditability, testing, reproducibility, and documentation.

**The zero-cost hosting is a School pilot profile, not enterprise hosting.** It has **no uptime SLA,
no automatic database backups, and no enterprise support**. The free database project pauses after a
week of inactivity. The free web service sleeps after fifteen minutes of inactivity. Assistive
processing is capped at 40 heavy runs per rolling 31-day window, and each run drains the whole queue.

**These are separate things.** Free hosting does not make the application weak; it means the School
should plan backups deliberately and decide whether to fund hosting later. Moving to funded
infrastructure needs no redesign — see the decision log.

**End-to-end assistive latency on hosted infrastructure has not yet been measured.** The PP1 target
is p95 under 3 minutes for an ordinary project. Confirm it during staging acceptance before relying
on the cloud profile; the School-owned continuous worker removes the polling delay entirely.

---

## 5. What only the School can do

Code cannot complete these. Each needs a person with institutional authority.

1. Create or nominate the institutional accounts and aliases that will own each resource.
2. Accept transfer of the repository, or fork it into a School organisation.
3. Accept transfer of the Supabase organisation and project, or provision a School-controlled one.
4. Accept transfer of the Admin/CMS hosting, or provision a School-controlled host.
5. Provide a School-controlled cloud subscription for the on-demand executor, **or** provide a
   Docker host for the continuous worker.
6. Confirm Duda ownership and publishing authority, and DNS ownership if a custom domain is used.
7. Approve an institutional email arrangement for participant notifications.
8. Settle the third-party redistribution position before any image is published publicly.
9. Receive every credential through an approved institutional procedure and revoke the previous ones.
10. Name a primary and backup owner for each responsibility in the role ownership matrix.
11. Create the real staff accounts and complete staff training.
12. Run acceptance testing with real School administrators and record the result.
13. Accept backup, restore, and incident-response responsibility.
14. Sign off the release acceptance checklist.

**Until these are done, this is a handover package, not a completed handover.** Nothing in this
repository claims otherwise, and nothing should be marked complete without evidence.
