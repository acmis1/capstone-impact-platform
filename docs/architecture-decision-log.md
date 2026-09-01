# Architecture Decision Log

**STATUS:** Current — architecture
**PURPOSE:** Architecture / historical decision record
**LAST VERIFIED:** 2026-08-28

Final decisions and the reasoning behind them, so a future maintainer never has to reconstruct
*why* from anyone's memory or from an AI assistant's conversation history.

Each entry records the decision, the reason, and what would justify revisiting it. Entries are not
edited to reflect later opinion; a changed decision gets a new entry.

Related: [Project Architecture and Constraints](project-architecture-and-constraints.md) ·
[Zero-Cost Assistive Executor](operations/zero-cost-assistive-executor.md) ·
[Handover entry point](handover/README.md)

---

## ADR-001 — Duda remains the public layer

**Decision.** The public showcase stays on the School's existing Duda site, consuming a compiled
JSON feed. The platform does not replace it.

**Reason.** Duda is already owned, paid for, and operated by the School, and staff already know it.
Replacing it would add cost, add a second thing to hand over, and solve no stated problem. The
manual page-building effort that motivated this project is removed by generating the feed, not by
moving the site.

**Revisit if.** The School retires Duda, or the feed contract can no longer express what the
showcase needs.

---

## ADR-002 — The Admin/CMS is the source of truth

**Decision.** The database behind the Admin/CMS holds authoritative project data. The public feed is
a derived artifact, compiled and published under governance.

**Reason.** A derived public layer can be rebuilt; an authoritative one cannot. Making the feed
derived means publication is reversible, auditable, and safe to automate, and the public site can
never become the only copy of anything.

**Revisit if.** Never, in practice. Reversing it would remove the audit trail and the rollback path.

---

## ADR-003 — No Duda plan upgrade

**Decision.** The integration works within the current Duda capabilities. No plan upgrade is
required.

**Reason.** Zero new recurring cost is a hard constraint, and the feed-plus-widget approach delivers
search, filtering, and detail pages without one.

**Revisit if.** The School independently upgrades for unrelated reasons.

---

## ADR-004 — AI stays assistive, permanently

**Decision.** OCR, language checking, and duplicate detection produce **suggestions**. They cannot
approve, publish, or silently change project metadata. Staff remain the authority, and the platform
works fully without them.

**Reason.** These are the requirement, not a limitation: the platform must remain fully functional
through deterministic rules and manual entry when the AI layer is slow, offline, or wrong. It also
means an assistive outage is never a workflow outage — which is what makes a free-tier executor
acceptable at all.

**Revisit if.** Never. Removing it would make availability a publication dependency.

---

## ADR-005 — The paid background worker is rejected

**Decision.** The Render background worker on a `2c-4g` plan is not deployed, and its blueprint is
deleted from the repository.

**Reason.** Render documents that background workers have no free instance type, so this design
carried a permanent monthly charge. PP1 must introduce **zero new recurring cost**, and a system
handed to the School with a standing bill is not handed over cleanly. Deleting the blueprint rather
than merely documenting the rejection prevents a future maintainer from redeploying it by accident.

**Revisit if.** The School funds hosting deliberately. Even then, the School-owned continuous worker
is likely the better answer, because it costs nothing and removes all polling delay.

---

## ADR-006 — Two execution profiles, one image

**Decision.** Assistive execution supports a zero-cost on-demand cloud profile and a School-owned
continuous profile. Both run the same image and the same code.

**Reason.** Neither alone is sufficient for handover. The cloud profile works when the School has no
suitable server; the School-owned profile works when it does, and is the provider-independent
fallback that keeps the platform from depending on any vendor. Sharing one image means neither
profile can quietly drift from the other.

**Revisit if.** The School standardises on one and wants the other removed. Keeping both is cheap;
removing the fallback is not.

---

## ADR-007 — A scheduled dispatcher, not direct event-driven scaling

**Decision.** A small scheduled dispatcher reserves a launch unit in the database and then requests
one worker execution. The worker is not scaled directly from the queue.

**Reason — and this is a cost-fencing decision, not a capability one.** Direct event-driven scaling
is technically supported and was seriously considered: the provider documents that event-driven jobs
may use a custom scale rule based on *any* ScaledJob-based KEDA scaler, KEDA ships a PostgreSQL
scaler, and Supabase documents custom database roles and the `[DB-USER].[PROJECT-REF]` pooler
username form over its free IPv4 session pooler. The design would work.

It was rejected because the scaler starts the container **before any application code runs**. A
container that then fails on image pull, bad environment, connectivity, or an early crash consumes
compute, consumes no budget unit, leaves the scale signal asserted, and gets started again.
`maxExecutions: 1` prevents *simultaneous* executions but imposes no ceiling on total starts over
time. Nothing in that design can cap billable starts, which is the one thing a hard zero-cost fence
must do.

Reserving the unit in the database first inverts the order to **database reservation → cloud start →
worker claim**, which is what makes the ceiling real.

**Revisit if.** The provider exposes an absolute execution-start quota suitable for this use. The
dispatcher could then be removed entirely, which would be a genuine simplification.

---

## ADR-008 — A rolling 31-day window, not a calendar month

**Decision.** The hard fence is **40 irrevocably consumed starts in any rolling 31-day window**. UTC
calendar-month counts are reported for operator readability and carry no authority.

**Reason.** The provider documents the free grant as "per subscription, per calendar month" but does
not document the timezone or the instant at which it resets. A hard fence must not depend on an
undocumented provider boundary. Every calendar month is at most 31 days, so bounding every rolling
31-day interval to 40 starts also bounds every calendar month to at most 40 — whatever the reset
instant turns out to be. The rolling window is strictly stronger and provider-independent.

**Revisit if.** The provider documents the reset boundary precisely. Even then the rolling window
remains safe, so there is little to gain.

---

## ADR-009 — The launch ceiling lives in the database schema

**Decision.** The limit, the window, and the single-active rule are `CHECK` constraints in Migration
0047. A separate constraint makes it impossible for a reservation to stop counting unless it is in
the one state that proves nothing was ever transmitted.

**Reason.** A constant in application code can be changed in a commit that looks harmless. A schema
constraint cannot: raising the ceiling requires a new forward migration, which is reviewed like any
other schema change. Putting the irrevocability rule in a constraint rather than only in a function
body means even an incorrect future change to that function cannot release a consumed unit.

**Revisit if.** A cohort genuinely needs more processing than 40 drains provide. The answer is
probably the School-owned continuous worker, which has no ceiling at all.

---

## ADR-010 — Ambiguity always consumes the unit

**Decision.** Once a start request has been transmitted, the unit is consumed permanently — whatever
status comes back, and even if nothing comes back. Only a failure proven to have occurred *before*
transmission releases it.

**Reason.** The system cannot distinguish "the provider rejected this and started nothing" from "the
provider started it and the response was lost". Guessing optimistically means an uncounted billable
execution, which breaks the zero-cost guarantee. Guessing conservatively costs at most one wasted
unit out of 40. The asymmetry is obvious once stated, so the design always over-counts.

**Revisit if.** Never. The failure modes are asymmetric.

---

## ADR-011 — A dedicated least-privilege database role for the dispatcher

**Decision.** The dispatcher authenticates as `capstone_assistive_dispatcher`, which can execute
exactly four execution-control routines in a schema that is not exposed through the Data API. It
holds no table privileges, no project data access, no workflow or publication routine, and no server
secret key.

**Reason.** The dispatcher is the one component holding cloud authority to start a job. Giving it a
server secret key as well would combine "can start compute" with "can read and write everything",
for a component whose entire job is four calls. Splitting them means neither the dispatcher nor the
worker can do the other's job.

**Revisit if.** Never. This is ordinary least privilege.

---

## ADR-012 — The worker claims its authorisation before loading any provider

**Decision.** The worker's first application action is to claim the reservation, presenting its
token, generation, deployment commit, image digest, and execution mode. Only then does it construct
any provider.

**Reason.** It makes an unauthorised execution — a portal "Run now", a duplicate, a stale replay, a
drifted deployment — cheap and harmless: the process exits in a second without loading PaddleOCR or
LanguageTool and without touching the queue. It also means the platform, not the cloud provider,
decides what may run.

**Revisit if.** Never.

---

## ADR-013 — Provider-neutral identity, with the previous names kept as aliases

**Decision.** Worker identity uses `CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID`,
`CAPSTONE_DEPLOYMENT_VERSION`, `CAPSTONE_ASSISTIVE_EXECUTION_MODE`, and
`CAPSTONE_ASSISTIVE_IMAGE_DIGEST`. The earlier hosting-provider variables are still accepted as
aliases.

**Reason.** Identity is a domain concept. Naming it after whichever platform happened to supply the
value first makes every future migration a rename. Keeping the aliases means the change breaks no
existing deployment.

**Revisit if.** The aliases can be dropped once no deployment relies on them.

---

## ADR-014 — Durable log storage is disabled

**Decision.** The executor environment stores no logs. Live streaming remains available, and durable
operational evidence is written to the database.

**Reason.** There is no cost-free retained-log option, and a monitoring service the application
needs in order to function would be a recurring dependency. Bounded database evidence is better
anyway: it is queryable by the same operators who run everything else, it is covered by the same
backup procedure, and it keeps participant content out of cloud logs.

**Revisit if.** The School already funds a log platform. Adding a diagnostic destination is then a
free-standing improvement.

---

## ADR-015 — The handover package is documentation-complete by design

**Decision.** Every operational procedure lives in this repository. No procedure may require access
to any AI assistant's conversation history, private messages, or anyone's memory.

**Reason.** A project team graduates. If knowledge that only exists in a chat log is load-bearing,
the system is not handed over — it is lent. The test is simple: a new technical maintainer with the
repository and nothing else must be able to operate it.

**Revisit if.** Never. Missing knowledge is a defect to fix here.
