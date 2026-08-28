# Zero-Cost Assistive Executor

**STATUS:** Current — operations and architecture
**PURPOSE:** Operations
**LAST VERIFIED:** 2026-08-28

How Assistive Checks are executed without introducing any new recurring cost, how to deploy and
operate the executor, and what is deliberately *not* promised by it.

Related: [Free-Tier Capacity and Handover](free-tier-capacity-and-handover.md) ·
[Architecture Decision Log](../architecture-decision-log.md) ·
[Handover entry point](../handover/README.md)

---

## 1. What this replaces

The previous hosted design ran the assistive coordinator as a Render **background worker** on a
`2c-4g` plan. Render documents that background workers have no free instance type, so that design
carried a permanent monthly charge and could not be handed to the School as a zero-cost system. The
blueprint that declared it has been removed from the repository so it cannot be redeployed by
accident.

Two supported execution profiles replace it.

| Profile | Where it runs | When to choose it |
| :--- | :--- | :--- |
| **A. Zero-cost on-demand executor** | Container Apps Consumption jobs in a School-controlled cloud subscription | No School server is available, and a free-grant cloud subscription exists |
| **B. School-owned continuous worker** | Any School Linux server, VM, or managed Docker host | Suitable institutional compute exists. Removes all polling delay and all cloud dependency |

Both profiles run the **same container image** and the **same application code**. Neither changes
OCR, language checking, duplicate detection, queue fencing, review, or publication behaviour.

---

## 2. Profile A — how it works

```text
staff select "Run assistive checks"
      │
      ▼
Admin/CMS enqueues one job on the existing PostgreSQL queue          (unchanged)
      │
      │   every 2 minutes (UTC cron)
      ▼
DISPATCHER JOB          0.25 vCPU · 0.5 GiB · 15 s timeout · no ingress
  1. verify staging runtime identity
  2. cheap read-only database probe                     ── no work? exit, no cloud traffic at all
  3. read and verify the deployed worker template, then project its Start-compatible execution fields
  4. RESERVE ONE LAUNCH UNIT                            ── the cost fence, before any cloud start
  5. durably mark the reservation as requested          ── point of no refund
  6. request exactly one worker execution, passing the reservation token
  7. record the outcome and exit
      │
      ▼
HEAVY WORKER JOB        2.0 vCPU · 4.0 GiB · 600 s timeout · no ingress · scaled to zero
  1. claim the reservation                              ── first action, before any provider loads
  2. publish readiness, then drain the queue until empty or the 8-minute budget is reached
  3. publish STOPPING, settle the reservation, exit
```

The dispatcher is the **only** authorised starter. A "Run now" started from a cloud portal carries
no reservation token and exits immediately without loading any provider or claiming any queue work.

The dispatcher reads the deployed Azure job template to verify its image, deployment, and worker
identity. Because it calls the Jobs - Start REST endpoint directly, it projects only that endpoint's
documented execution-template fields: containers and optional init containers, with each container's
name, image, command, args, environment, and resources preserved. Template-only features that Start
cannot represent, including volumes, probes, volume mounts, or any unmodelled template field, fail
closed before a launch is reserved. If future executor IaC needs one of those features, reevaluate the
execution-override strategy before deploying it.

There is no public execution endpoint, no worker URL, no health-check path, and no command payload.
Container Apps jobs do not support ingress at all.

### Why a dispatcher rather than direct event-driven scaling

An event-driven job scaled straight from the queue is technically supported and was seriously
considered. It was rejected for one reason: it starts the container *before* any application code
runs, so nothing can cap the number of billable starts. Reserving the unit in the database first is
what makes the ceiling real. See the decision log for the full record.

---

## 3. The launch ceiling

> **Hard cost fence: at most 40 irrevocably consumed heavy-worker starts in any rolling 31-day
> window.**
>
> **Operator display: UTC calendar-month starts. Reporting only — it carries no authority.**

The provider documents its free grant as "per calendar month" but does not document the timezone or
instant at which that grant resets. A hard fence must not depend on an undocumented boundary. Every
calendar month is at most 31 days, so bounding every rolling 31-day interval to 40 starts also
bounds every calendar month to at most 40 starts, whatever the provider's reset instant is.

The ceiling is enforced by `CHECK (launch_limit = 40)` and `CHECK (window_days = 31)` in Migration
0047, not by configuration. No environment variable, deployment parameter, Admin action, or browser
path can raise it; doing so requires a new reviewed forward migration. `npm run check:zero-cost`
fails the build if the constraint, the window, or the arithmetic drifts.

### Once a start request is sent, the unit is gone

| Situation | Unit consumed? |
| :--- | :--- |
| Preflight failed before any request was sent (token, template read, identity, validation) | No — nothing was reserved yet |
| Reservation made, then the database confirms the durable "requested" mark was fenced | No — released, because the database proves nothing was transmitted |
| Request sent, accepted (200 or 202) | **Yes** |
| Request sent, any error status received (4xx, 429, 5xx) | **Yes** |
| Request sent, timeout, reset, or unreadable response | **Yes** |
| Request sent, container failed to start | **Yes** |
| Dispatcher died at any point after the durable mark | **Yes** |
| Reservation expired without settlement | **Yes** |

This deliberately prefers a false-positive consumption over an uncounted billable execution. A
database `CHECK` constraint makes any other release impossible.

Only one heavy execution may be active at a time, evaluated under the same row lock as the ceiling.

---

## 4. What happens when the limit is reached

Assistive Checks become unavailable. **Nothing else changes.** Staff can still import, edit,
validate deterministically, review, preview, correct, approve, and publish. Historical findings
remain readable. No project is stuck, no approval state is corrupted, and nothing is published
automatically.

The Admin interface says so plainly:

> Assistive checks have reached their processing limit for now. You can continue reviewing and
> editing project information manually.

AI availability is never publication authority.

---

## 5. Deployment

### 5.1 Prerequisites

- A School-controlled cloud subscription. Deploying the custom role definition requires **Owner** or
  **User Access Administrator** on the target resource group.
- The Supabase project, its server secret key, and its canonical hostname.
- Container images built from the exact reviewed commit, and their **immutable digests**.

### 5.2 Build the images

```bash
# Manual workflow. Publishing is off by default; see docs/handover/third-party-licences.md first.
gh workflow run assistive-worker-image.yml -f build_worker=true -f build_dispatcher=true
```

The build verifies the frozen PP-OCRv6 and LanguageTool artifact hashes and prints both digests.
Record them: the infrastructure template is pinned to digests, never to a tag.

### 5.3 Create the dedicated database role

Migration 0047 creates `capstone_assistive_dispatcher` with login enabled but no password, so it
cannot authenticate until an operator sets its password through an interactive `psql` prompt. This
keeps the value out of source, command history, and process arguments:

```sql
\password capstone_assistive_dispatcher
```

The role can execute exactly four execution-control routines. It holds no table privileges, no
project data access, no workflow or publication routine, and no server secret key.

Build its connection URL against the **shared session-mode pooler on port 5432**, which is the
IPv4-reachable option on every Supabase tier. The direct connection is IPv6-only unless a paid IPv4
add-on is purchased, so it must not be used. The dispatcher verifies the exact project-qualified
role, `<project-ref>.pooler.supabase.com` host suffix, port `5432`, `/postgres` database, and a
non-empty password before opening `pg`; query strings and fragments are refused.

```text
postgresql://capstone_assistive_dispatcher.<PROJECT_REF>:<password>@<pooler-host>:5432/postgres
```

### 5.4 Deploy the infrastructure

```bash
az bicep build --file infra/azure/assistive-executor/main.bicep
az deployment group what-if --resource-group <rg> --template-file infra/azure/assistive-executor/main.bicep --parameters @<your-local-params>
az deployment group create  --resource-group <rg> --template-file infra/azure/assistive-executor/main.bicep --parameters @<your-local-params>
```

See [the template README](../../infra/azure/assistive-executor/README.md) for every parameter.
The sample parameter file selects `southeastasia`: the Consumption profile supports that region and
it is closer to the existing Singapore Supabase staging data plane. `location` remains a parameter
for an institution with a residency requirement that needs another supported region.

### 5.5 Register the executor

Nothing can start until the deployed identity is registered. This is one operator command, and it is
also the rollout check:

```bash
npm run register:assistive-executor -- \
  --deployment-version=<40-hex commit> \
  --image-digest=sha256:<worker image digest> \
  --configuration-version=zero-cost-executor/v1
```

### 5.6 Enable staff access

Set on the Admin/CMS service, then redeploy it:

- `CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED=true`
- `CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION=<40-hex commit>`
- `CAPSTONE_ASSISTIVE_EXPECTED_WORKER_IMAGE_DIGEST=sha256:<worker image digest>`

Admin permits enqueue only when the registered executor matches these exactly. A drifted deployment
or image fails closed.

---

## 6. Profile B — School-owned continuous worker

The same image, run continuously on School compute. No cloud subscription, no dispatcher, no launch
ceiling, and no polling delay.

```bash
docker build -f apps/assistive-worker/Dockerfile.hosted -t capstone-assistive-worker:<commit> .

docker run --rm --name capstone-assistive-worker \
  --cpus 2 --memory 4g \
  --env-file <approved-secret-env-file-outside-the-repository> \
  -e CAPSTONE_RUNTIME_ENV=staging \
  -e CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED=true \
  -e CAPSTONE_ASSISTIVE_EXECUTION_MODE=CONTINUOUS \
  -e CAPSTONE_EXPECTED_SUPABASE_HOST=<project-ref>.supabase.co \
  -e CAPSTONE_ASSISTIVE_SUPABASE_URL=https://<project-ref>.supabase.co \
  -e CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID=<host-scoped identifier> \
  -e CAPSTONE_DEPLOYMENT_VERSION=<40-hex commit> \
  -e CAPSTONE_ASSISTIVE_PADDLE_MODELS_DIR=/opt/capstone/artifacts/paddle \
  -e CAPSTONE_ASSISTIVE_LANGUAGETOOL_ARCHIVE=/opt/capstone/artifacts/languagetool/LanguageTool-stable.zip \
  -e CAPSTONE_ASSISTIVE_LANGUAGETOOL_JAR=/opt/capstone/artifacts/languagetool/LanguageTool-6.6/languagetool-server.jar \
  capstone-assistive-worker:<commit>
```

The external environment file supplies `SUPABASE_SECRET_KEY`. Store it with owner-only permissions
under the School's approved secret procedure, never in this repository, and remove it when the host
is decommissioned.

Requirements: 2 CPU and 4 GB RAM minimum, outbound HTTPS to the approved Supabase host only, and a
graceful stop (`docker stop`, default SIGTERM) so the worker can finish its fenced operation and
publish `STOPPING`. Run **exactly one instance**: horizontal scaling has not been capacity-qualified.

Because a continuous worker publishes a heartbeat every 15 seconds, Admin reports it as ready
directly and never consults the launch ceiling. Building locally from this repository also avoids
redistributing any third-party artifact.

---

## 7. Operating the executor

### 7.1 Everyday checks

| Question | How to answer it |
| :--- | :--- |
| Is assistive processing available to staff? | The project page shows the control enabled, or states the reason it is not |
| How much launch capacity remains? | `get_assistive_executor_availability` returns `remainingInWindow` from a governed server context |
| Is a heavy execution running now? | The same routine returns `activeExecutions` |
| Did the last execution succeed? | It returns `lastExecutionAt` and the registration's last outcome |
| Is the queue backing up? | `get_assistive_validation_job_health` returns queued, active, and expired-lease counts |
| Is the deployed version the reviewed one? | Compare the registration's deployment version and image digest against the release record |

Live container logs are available for troubleshooting. Durable log storage is deliberately disabled
(there is no cost-free retained-log option), so operational evidence lives in the database instead.
Poster text and participant content are never written to cloud logs.

### 7.2 Common failures

| Symptom | Likely cause | Safe diagnosis | Safe remediation | Escalate when |
| :--- | :--- | :--- | :--- | :--- |
| Staff see "temporarily unavailable" | No fresh heartbeat and no valid registration | Check the availability routine and the expected-identity variables on Admin | Re-register the executor, or correct the expected identity | The registration matches but availability still fails |
| Staff see "processing limit reached" | 40 starts consumed inside the rolling window | Read `consumedInWindow` and `remainingInWindow` | Wait for the oldest start to age past 31 days; use Profile B if the workload is genuinely larger | Capacity is structurally insufficient for the cohort |
| Jobs stay queued, nothing starts | Dispatcher not running, unregistered, or refused | Read recent dispatcher executions; run the probe from a governed context | Fix the reported reason. Never start the worker job manually — it will refuse | The dispatcher reports repeated `PREPARE_FAILED` |
| Repeated `PREPARE_FAILED` | Image digest drift, or the identity has no permission | Compare the deployed job image against the registered digest | Redeploy the reviewed digest, or repair the role assignment | The role assignment is correct and it still fails |
| Worker starts then exits immediately | Reservation refused: wrong generation, expired, already claimed, or identity mismatch | Read the reservation state and outcome code | Usually correct behaviour — this is the fence working | It recurs on every dispatch |
| Capacity consumed with no work done | Container failing to start after a request was sent | Check container start logs | Fix the image or environment before the next window | More than two consecutive starts fail |
| Provider or startup failure | Artifact hash mismatch or missing Java | Check the container's startup output | Rebuild the exact reviewed commit. Never bypass hashes or widen versions | The exact commit will not build |

Do not clear claim tokens, edit job rows, or delete queued jobs by hand. Existing lease recovery
handles crashes: the lease expires, and the job becomes eligible again with its attempt bound
intact.

There is no "reset everything" procedure, and none should be invented.

### 7.3 Stopping and restarting

- **Pause processing:** disable `CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED` on Admin, or suspend
  the dispatcher job. Queued jobs simply wait.
- **Resume:** re-enable, confirm availability reports ready, then tell staff.
- **Rollback:** deploy the previously registered digest and re-register it. A rollback is valid only
  to a commit with the same pipeline and capability identities and a compatible schema. Never roll a
  database migration back through the executor.
- **Rotate the dispatcher credential:** `ALTER ROLE capstone_assistive_dispatcher WITH PASSWORD …`,
  update the job secret, and confirm the next dispatch succeeds.
- **Rotate the server secret key:** update the worker job secret and confirm the next execution
  publishes a heartbeat. Never print either value into logs, commands, source, or browser
  configuration.

---

## 8. What this profile does not promise

The zero-cost profile is a **School pilot / operational profile**, not enterprise hosting. Stated
plainly so nobody is surprised:

- **No uptime SLA.** Free tiers carry no availability guarantee.
- **No automatic database backups.** Backup and restore are operator-driven; see the recovery
  runbook.
- **No enterprise support.** Community support only.
- **The database project pauses after a week of inactivity** on the free plan and must be resumed.
- **The free grant is per subscription.** If unrelated workloads share the subscription, the PP1
  ceiling alone cannot guarantee a zero bill. A dedicated School-controlled subscription is the
  preferred arrangement.
- **End-to-end latency is not yet measured on hosted infrastructure.** See below.

### End-to-end latency is a pending acceptance gate

The PP1 acceptance target for ordinary projects is **end-to-end p95 under 3 minutes on the minimum
supported machine**, and **under 90 seconds on recommended hardware**. That target is unchanged.

Profile A adds a detection delay of up to 2 minutes plus cloud cold start before processing begins.
Whether the whole sequence still meets the target **has not been measured on real hosted
infrastructure and is not claimed here**. The measurement boundary is:

```text
staff action → enqueue accepted → dispatcher detection → worker start and cold start
→ queue claim → extraction, OCR, language, duplicate checks → findings persisted
→ result visible in Admin
```

Record p50 and p95 across that entire sequence during staging acceptance.

- **p95 at or under 3 minutes:** the cloud profile meets the minimum gate.
- **p95 above 3 minutes:** do not change the target. Investigate a safe zero-cost responsiveness
  improvement first. If no zero-cost cloud design can meet it while keeping the cost and security
  fences, report the trade-off to the coordinator and SSET. Profile B removes the polling delay
  entirely and may be the better institutional answer.

The separately qualified **OCR provider** latency (p50 ≤ 10,000 ms, p95 ≤ 20,000 ms — see
[the OCR latency result](../assistive-validation/ocr-title-latency-result.md)) is a different
measurement of a different thing. It remains valid and is not a substitute for the end-to-end
figure.

If observed platform behaviour ever invalidates the free-tier assumptions, **stop the cloud profile
and move to Profile B** rather than continuing to gather evidence while a bill accrues.

---

## 9. Provider portability

The assistive domain knows about a queue, a worker, a run, a finding, executor readiness, and a
launch policy. It does not know about any cloud provider. Exactly one module — the executor launcher
adapter — speaks to a cloud control plane, and the infrastructure template is the only file naming
provider resources.

Moving to a Kubernetes Job, a systemd timer, an institutional batch scheduler, or another serverless
job runner means replacing that one adapter and that one template. It requires no change to OCR,
language checking, duplicate detection, queue fencing, the Admin interface, publication, or the
project schema.
