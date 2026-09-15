# Free-Tier Capacity and Handover

**STATUS:** Current — operations
**PURPOSE:** Operations
**LAST VERIFIED:** 2026-09-14

Every free-tier dependency the platform relies on, what happens when each one runs out, and who must
watch it after handover.

Related: [Zero-Cost Assistive Executor](zero-cost-assistive-executor.md) ·
[Resource Ownership Matrix](../handover/resource-ownership-matrix.md) ·
[Handover entry point](../handover/README.md)

---

## 1. How to read this document

Every provider figure below was transcribed from official documentation on the verification date and
is cited. **Re-verify before each showcase cycle** — free tiers change, and a stale figure here is a
release defect, not a documentation nicety. Section 6 is the procedure.

The compute arithmetic is not prose: it is computed in
[`zeroCostExecutionEnvelope.ts`](../../apps/admin-cms/src/operations/zeroCostExecutionEnvelope.ts)
and enforced by `npm run check:zero-cost` on every CI run. If a change pushes usage past a grant,
the build fails.

---

## 2. Dependency register

### Container Apps Consumption (assistive executor, Profile A only)

| Field | Value |
| :--- | :--- |
| Free limit | 180,000 vCPU-seconds and 360,000 GiB-seconds per **subscription** per calendar month |
| Source | `https://learn.microsoft.com/en-us/azure/container-apps/billing` (verified 2026-08-28) |
| PP1 expected use | Far below the ceiling. The dispatcher dominates and its real work is a few seconds per run |
| PP1 hard limit | 134,100 vCPU-s and 268,200 GiB-s — **74.5% of each grant** in a worst-case 31-day month |
| Warning threshold | Any change that pushes computed usage above 85% of either grant |
| Behaviour when exhausted | Assistive Checks stop. The rest of the platform is unaffected |
| Monitoring | `npm run check:zero-cost` in CI; the subscription's own cost view for actual spend |
| Free-compatible response | Keep Profile A within its verified free grant; if it is insufficient, use institution-provided/School-owned compute (Profile B) or escalate a future institutional decision outside PP1. No paid subscription is required or authorised for PP1 |
| Institutional owner | Technical maintainer, with the subscription owner |

Worst-case arithmetic, 31-day month:

```text
Dispatcher   */2 cron → 31 × 24 × 30 = 22,320 executions
  22,320 × 15 s × 0.25 vCPU  =  83,700 vCPU-s
  22,320 × 15 s × 0.50 GiB   = 167,400 GiB-s

Heavy worker  40 starts × (600 s timeout + 30 s conservative start allowance)
  40 × 630 s × 2.0 vCPU      =  50,400 vCPU-s
  40 × 630 s × 4.0 GiB       = 100,800 GiB-s

TOTAL        134,100 vCPU-s (74.5%) · 268,200 GiB-s (74.5%) · 25.5% headroom
```

**Two honest caveats.**

*Start-time sensitivity.* The provider documents the meter as "resources allocated to each replica
while it's running" and documents no separate meter for container start. The dispatcher line above
therefore models billed time as exactly its 15-second timeout. The verifier also prints the
break-even: this configuration absorbs about **8.2 seconds** of extra dispatcher time per execution
before exceeding the grant. If real billing evidence shows startup is billed, the reviewed lever is
a one-line change to a `*/3` cadence (about 19.8 seconds of tolerance), which CI also accepts. No
measured startup overhead is claimed here — that is measured during real deployment.

*Subscription scope.* The grant is per subscription. If unrelated workloads share it, the PP1
internal limit alone cannot guarantee a zero bill. A dedicated School-controlled subscription is the
preferred arrangement; where that is impossible, the School must monitor aggregate consumption.

### Supabase Free (database, auth, storage — all environments)

| Field | Value |
| :--- | :--- |
| Free limit | 500 MB database, 1 GB file storage, 5 GB egress, 5 GB cached egress, 50,000 monthly active users, 2 active projects per organisation |
| Source | [`Supabase pricing`](https://supabase.com/pricing) (verified 2026-09-14) |
| PP1 expected use | Roughly 120 projects per cycle plus private media. Media dominates storage |
| Warning threshold | 70% of database size or file storage |
| Behaviour when exhausted | Free projects enter read-only mode when database usage exceeds 500 MB; storage, Auth, or API operations can also be refused by the affected quota/service |
| Pause/recovery | Low-activity Free projects may be paused after 7 days; resume in the Dashboard. A paused project can be restored for up to 1 year; after that, export/migrate before the restore window expires |
| Backups | **Not included on Free.** Supabase recommends scheduled CLI database dumps and off-site retention; Storage objects require a separate export |
| SLA / support | None. Community support only |
| Monitoring | Project usage view; storage inventory during the recovery drill |
| Free-compatible response | Archive completed cycles and export/retain database and Storage evidence where valid; if the free envelope is insufficient, escalate an institution-provided hosting/storage decision outside PP1. No paid Supabase plan is required or authorised for PP1 |
| Institutional owner | Database / infrastructure maintainer |

The one-week pause matters operationally: a project left idle over a semester break will be asleep
when staff return. Resuming it is a routine dashboard action, and the executor will simply report
unavailable until it is back.

### Render Free (Admin/CMS web service)

| Field | Value |
| :--- | :--- |
| Free limit | 750 free instance hours per workspace per calendar month |
| Source | [`Render Free`](https://render.com/docs/free) (verified 2026-09-14) |
| Free service types | Web services, static sites, Postgres, Key Value. **Background workers and cron jobs are not available on Free** |
| Spin-down | Free web services suspend after 15 minutes of inactivity and take about a minute to wake |
| Behaviour when exhausted | Render suspends all Free web services until the next month; outbound bandwidth/build limits can otherwise incur charges when a payment method is present, so this project must not add one or accept paid overage |
| Monitoring | Workspace usage view |
| Production status | Free instances should not be used for production applications; use Render Free only for temporary/demo/test/team-operated hosting. Institutional production hosting is an RMIT/School handoff dependency |
| Free-compatible response | Keep the current Free service temporary/demo/test/team-operated, or hand the Admin/CMS to RMIT/School-approved infrastructure for production. No paid Render subscription is required or authorised for PP1 |
| Institutional owner | Technical maintainer |

Render's current Free documentation says Free instances should not be used for production
applications. The current Render Free service is therefore temporary/demo/test/team-operated
hosting only, not institutional PP1 production acceptance; production hosting remains an
RMIT/School handoff dependency. The absence of a free background worker is why continuous Profile B
processing remains School-owned. A Free web service spins down after 15 minutes without inbound
HTTP traffic or an incoming WebSocket message and takes about a minute to wake. Note also that
24×31 = 744 hours: one always-awake free service consumes essentially the entire workspace grant,
which is why nothing in this design keeps a web service artificially awake. No paid Render
subscription is required or authorised for PP1.

### GitHub Actions and Container Registry

| Field | Value |
| :--- | :--- |
| Free limit | Actions is free for public repositories on standard runners. Packages usage is free for public packages, and container storage and bandwidth are currently free |
| Source | `https://docs.github.com/en/billing/concepts/product-billing/github-actions`, `.../github-packages` (verified 2026-08-28) |
| Caveat | Private packages on the Free plan include only 500 MB of storage. The verified local worker image is 1,595,460,411 bytes before registry compression, so do not assume it fits: measure its compressed registry storage first |
| Behaviour when exhausted | Not applicable while the repository and packages remain public |
| Monitoring | Organisation billing view after any move to private |
| Institutional owner | Repository owner |

Publishing images publicly is a redistribution decision, not merely a technical one. Read
[the third-party licence review](../handover/third-party-licences.md) before enabling it. Profile B
needs no registry at all.

---

## 3. Dependency-specific outage behaviour

The assistive worker is not the same dependency as the Admin/CMS host or Supabase. The recovery
path must name which boundary failed:

| Failure | What is blocked or degraded | What remains available | Safe operator response |
| :--- | :--- | :--- | :--- |
| Profile B worker stopped, stale, incompatible, or unable to process | Assistive checks only; new assistive runs stay unavailable or queued | Admin/CMS, Supabase-backed project data, deterministic validation, review, preview, correction, approval, and publication when their own dependencies are healthy | Stop retrying the worker blindly; inspect bounded logs, correct the reviewed image/configuration, or leave assistive checks disabled while core work continues |
| Supabase database/Auth/API outage, pause, or database quota read-only mode | Any core action requiring that Supabase boundary, including sign-in, reads, writes, queue/finding persistence, and possibly review/publication | Only already-loaded browser state and truly local evidence; do not claim the application remains operational | Resume/restore through the Supabase operator path, verify backups/exports, and rerun readiness; never delete history/assets to fit a quota |
| Supabase Storage outage, quota, or object failure | Media upload/download and any workflow step requiring the affected objects | Metadata-only actions that do not need the unavailable object, if the Admin/CMS and database remain healthy | Repair/restore Storage and reconcile object references; do not replace missing media with fabricated content |
| Render Admin/CMS web service spun down or unavailable | Browser access and all actions that require the web service until it wakes or recovers | A separate healthy Profile B worker cannot substitute for the unavailable Admin/CMS | Wait for the normal wake-up or restore the web host; do not keep it awake with synthetic traffic |

Assistive failure remains fail-closed: it cannot approve, publish, or corrupt authoritative workflow
state. That guarantee does **not** mean a database/Auth/Storage or web-host outage is assistive-only.
When those core dependencies fail, report the corresponding core outage honestly and resume only
after the dependency and readiness checks pass.

No project is published automatically. Historical findings remain readable when their database and
Storage dependencies are healthy. **AI availability is never publication authority.**

---

## 4. Capacity monitoring

The School should be able to answer, without the project team:

| Question | Where |
| :--- | :--- |
| Database size against the allowance | Supabase project usage view |
| Storage size against the allowance | Supabase storage usage view |
| Egress trend | Supabase usage view, where observable |
| Heavy-worker starts used and remaining | `get_assistive_executor_availability` (`consumedInWindow`, `remainingInWindow`) |
| Whether a heavy execution is running | The same routine (`activeExecutions`) |
| Dispatcher compute envelope | `npm run check:zero-cost` |
| Current executor readiness | The same routine, plus the Admin project page |
| Deployed worker version and image | The registration's deployment version and image digest |
| Repository migration state | `/api/readiness` |

There is no public infrastructure dashboard and none should be created. Nothing above exposes a
secret.

---

## 5. Cost-avoidance rules

These are the standing rules that keep the platform at zero new recurring cost. Any change that
breaks one is a release defect.

1. No paid background worker or paid always-on compute.
2. No dedicated cloud workload profile — Consumption only.
3. No paid log analytics workspace. Durable log storage is disabled; evidence lives in the database.
4. No paid container registry.
5. No paid virtual-network component, NAT gateway, or static public address.
6. No paid IPv4 database add-on — use the free IPv4 session-mode pooler.
7. No cloud OCR, cloud grammar, or model API of any kind.
8. No keeping a free web service artificially awake to simulate a worker.
9. No monitoring service that the application needs in order to function.

`npm run check:zero-cost` mechanically enforces rules 1 to 5 against the repository.

---

## 6. Provider terms review procedure

**Before each major semester or showcase cycle**, the technical maintainer re-verifies:

1. The Container Apps Consumption free grant and its scope.
2. Supabase Free limits, the 7-day inactivity pause, the 1-year restore window, database read-only threshold, backup position, and pooler connectivity options. Use the [`project pausing`](https://supabase.com/docs/guides/platform/free-project-pausing), [`database size`](https://supabase.com/docs/guides/platform/database-size), and [`backup`](https://supabase.com/docs/guides/platform/backups) pages (verified 2026-09-14).
3. Render Free limits, 15-minute spin-down, one-minute wake-up, and which service types remain free. Use [`Render Free`](https://render.com/docs/free) (verified 2026-09-14).
4. GitHub Actions and Packages terms for public repositories.
5. Third-party licences for the bundled providers.

Update the figures and the verification date in
[`zeroCostExecutionEnvelope.ts`](../../apps/admin-cms/src/operations/zeroCostExecutionEnvelope.ts)
and in this document, then run `npm run check:zero-cost`.

If terms have changed, decide explicitly:

- **Still free within the envelope?** Record the new figures and continue.
- **No longer free?** Move to Profile B, the School-owned continuous worker. It has no cloud cost.
- **Neither is viable?** Escalate to the School for institutional cloud funding. Do not quietly
  accept a recurring charge.
