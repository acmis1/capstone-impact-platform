# Release Rollout Runbook — Admin/CMS and continuous assistive worker

**STATUS:** Current — operational procedure
**PURPOSE:** Operations
**LAST VERIFIED:** 2026-09-21 (source inspection and resolver tests; no hosted step executed)

This runbook is the single procedure for moving the staging Admin/CMS and its continuous assistive
worker (Profile B) from one commit to another, and for rolling back. Generated handoff packages
and release records link here instead of restating the steps. It complements, and does not replace,
[School-owned continuous assistive worker](school-owned-continuous-assistive-worker.md) (host
preparation, `verify.sh`, secrets) and the
[Admin/CMS hosted deployment guide](../admin-cms-hosted-deployment.md) (Render contract,
readiness). Which commits are *currently* deployed is stated only in the
[release and closure status record](../handover/release-closure-status.md).

---

## 1. The identity contract (source-backed)

Assistive execution is available to staff only when three identities agree exactly. None of them
may be weakened to make a release easier; they are the fail-closed guard against running a worker
that does not match the application.

| Identity | Where it comes from | Source of the rule |
| --- | --- | --- |
| **Application runtime commit** | `RENDER_GIT_COMMIT` (accepted only with `RENDER=true`) or `CAPSTONE_DEPLOYMENT_VERSION` on the Admin/CMS process | `apps/admin-cms/src/assistive-validation/repositories/assistiveWorkerHeartbeatRepository.ts` — `resolveAssistiveWorkerRuntimeIdentity()` |
| **Application expected-worker configuration** | `CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION` on the Admin/CMS process | same resolver: it returns `null` unless every populated runtime identity equals this value |
| **Worker heartbeat identity** | `CAPSTONE_DEPLOYMENT_VERSION` in the worker container, published with every heartbeat; it is also the image tag and the `org.opencontainers.image.revision` label (`infra/assistive-worker/compose.yaml`, `Dockerfile.hosted` build argument) | `get_assistive_worker_availability` in `infra/supabase/migrations/20260918120000_governed_project_maintenance.sql` counts only `READY` heartbeats whose `deployment_version = p_deployment_version` within the 60-second freshness window |

`resolveAssistiveExecutionAvailability()` (`services/assistiveExecutionAvailability.ts`) calls the
resolver **before** either the continuous-heartbeat path or the on-demand path. Consequences:

- Pipeline version (`assistive-deterministic-checks/v4`) and the OCR/language capability strings
  are necessary but **not sufficient**; the commit identities must also match.
- An Admin/CMS redeploy at a new commit with an unchanged expected-worker variable makes the
  resolver return `null`: staff see "temporarily unavailable" even though the old worker is still
  heartbeating. Verified with the production resolver on 2026-09-21
  (`apps/admin-cms/src/assistive-validation/__tests__/rolloutIdentityContract.test.ts`).
- A new-commit worker heartbeating against an old-commit application is likewise not counted.
- Therefore **every application commit change is a coordinated three-part change**: application
  build, application configuration, worker container. There is no order that avoids a bounded
  window in which assistive checks are unavailable. Core import, review, preview and publication
  never depend on the worker and keep working throughout.
- The on-demand profile additionally requires `CAPSTONE_ASSISTIVE_EXPECTED_WORKER_IMAGE_DIGEST`
  and a registered executor; it is not used by the current continuous staging worker and must not
  be set for it.

## 2. Graceful stop — what the worker actually does

`apps/admin-cms/src/scripts/runHostedAssistiveCoordinator.ts` turns `SIGTERM`/`SIGINT` into an
`AbortController` abort. `runHostedAssistiveWorkerLoop()` then finishes the `runOnce()` that is in
flight (an OCR + LanguageTool run can take minutes), stops polling, publishes a final `STOPPING`
heartbeat and exits. Nothing in the loop cancels a running job on signal.

- `infra/assistive-worker/compose.yaml` sets `stop_grace_period: 10m`, so `docker compose stop
  worker` sends `SIGTERM` and waits up to ten minutes before `SIGKILL`. A plain `docker stop`
  without `-t 600` waits only ten seconds and would kill an in-flight run. `docker kill` must not
  be used.
- If the grace period is exhausted, the in-flight job keeps its 120-second lease
  (`LEASE_SECONDS` in `services/assistiveCoordinator.ts`); once the lease expires the claim RPC
  re-offers the job (attempt bound 2) and marks it `FAILED` with `WORKER_TIMEOUT` after the second
  expiry (`infra/supabase/migrations/20260820160000_assistive_validation_job_coordination.sql`).
  Queued jobs are untouched. Never clear claim tokens or edit queue rows by hand.
- After the last `STOPPING` heartbeat, availability reports `UNAVAILABLE` immediately; a stale
  `READY` heartbeat ages out within 60 seconds in any case.

## 3. Rollout procedure (staging, Profile B, no schema change)

Preconditions: the release commit `M` is merged to `main`; post-merge CI is green on `M`;
`M` adds no migration (a migration release additionally follows the maintenance-window steps in
the hosted deployment guide and the staging reconciliation runbook). Let `P` be the currently
deployed commit and image recorded in the status record.

1. **Build and accept the worker image at `M` on the Linux amd64 Docker host** using the external
   env file with `CAPSTONE_DEPLOYMENT_VERSION=M`: `sh infra/assistive-worker/verify.sh image
   /abs/path/worker.env staging`. This builds
   `capstone-assistive-worker:M` with build argument `CAPSTONE_DEPLOYMENT_VERSION=M`, checks the
   `org.opencontainers.image.revision` label, and writes the commit-specific acceptance record with
   the immutable image ID (`docker image inspect --format '{{.Id}}'`). Record that image ID. The
   old worker keeps running during the build.
2. **Announce the assistive-only window** to staff. Core workflow remains available.
3. **Stop the old worker gracefully**: `docker compose --project-directory infra/assistive-worker
   --env-file /abs/path/worker.env stop worker` (10-minute grace, see §2). Confirm the container has
   exited and its last heartbeat is `STOPPING`. Two continuous workers must never run at once.
   *Assistive unavailability window starts here.*
4. **Reconfigure and redeploy the Admin/CMS as one change**: in the Render service set
   `CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION=M` (leave every other variable, in
   particular `CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED=true` and the expected Supabase host,
   unchanged), then trigger the manual deploy of commit `M` (auto-deploy stays off). Saving the
   variable alone restarts the previous build with a mismatched expectation, which is acceptable
   only because the window is already open; do not leave it in that state.
5. **Start the new worker**: set `CAPSTONE_DEPLOYMENT_VERSION=M` in the external env file, then
   `docker compose --project-directory infra/assistive-worker --env-file /abs/path/worker.env up -d
   --no-build worker`, then `sh infra/assistive-worker/verify.sh running /abs/path/worker.env
   staging` (exactly one container, accepted image ID, revision label `M`, non-root, read-only,
   no published port, no injected init).
6. **Verify — the application and the worker separately**:
   - `GET /api/readiness` returns `readiness: ready`, `deploymentCommit.value = M`,
     `expectedMigrations.count` equal to the tracked inventory, `databaseCapability: current`;
     `GET /api/health` returns 200. **This proves the application only.**
   - Worker: verify fresh `READY` heartbeat records (the publisher interval is 15 s); do not
     assume the container logs print heartbeat payloads. `get_assistive_worker_availability` (governed server
     context) returns `AVAILABLE` with `compatibleWorkerCount = 1` for `deployment_version = M`, or
     equivalently a project page shows the assistive control enabled rather than "temporarily
     unavailable". Availability must be observed **after** step 4 completed; an observation taken
     while the old build was still serving proves nothing.
   - A queued job (if any) is claimed and completes with the `M` pipeline identity.
   *Assistive unavailability window ends when both checks pass.*
7. **Record the receipt before anything else**: commit `M`, Render deploy id, readiness body,
   worker image ID and container ID, `verify.sh running` output, the availability observation with
   its timestamp, and the window start/end. Then update the status record (§5 below).

## 4. Rollback (to the previous commit `P`)

Rollback restores **configuration and both binaries**; restoring only one of them recreates the
mismatch described in §1.

1. Stop the `M` worker gracefully (§2).
2. On the Render service set `CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION=P` and
   redeploy `P` (Render "rollback to previous deploy" restores the build, **not** the environment
   variable — set it explicitly).
3. Set `CAPSTONE_DEPLOYMENT_VERSION=P` in the external env file and start the previously accepted
   image `capstone-assistive-worker:P` (its acceptance record and image ID are in the previous
   receipt) with `up -d --no-build`, then `verify.sh running`.
4. Verify exactly as in §3 step 6 and record a rollback receipt.

Rollback is valid only to a commit with the same pipeline and capability identities and a
compatible schema; database migrations are never rolled back through the worker.

Trigger conditions: readiness not `ready` or wrong commit; no compatible `READY` heartbeat within
two minutes of step 5; `verify.sh running` failure; any retained-data mismatch in the release
retention comparison.

## 5. Recording and packaging order — the composite identity

1. Receipts first (§3 step 7). No package is "released" until the runtime it describes has been
   observed running.
2. Update `docs/handover/release-closure-status.md`: set `deployed-backend` (and, if the Duda
   TEST layer was re-installed, `public-layer`) in the `current-identity` block to the observed
   commits, and add the receipt references. This is normally a **documentation-only commit `D`**
   on `main` after `M`.
3. `main` (`D`) and `deployed-backend` (`M`) now legitimately differ. That is the intended
   composite identity: the deployed runtime is `M`; the source of record is `D`; the difference is
   documentation. **Do not redeploy to make the SHAs equal** — a documentation-only commit changes
   no runtime behaviour, and redeploying it would only reopen the assistive window and require a
   new receipt, which is the self-referential loop this rule exists to prevent. Redeploy only when a
   later commit changes runtime code, and then start again at §3.
4. Build the released package from `D` with the observed identities as build inputs:
   `npm run handoff:build -- --out <output-directory> --status released --commit D --deployed-backend M --worker-image
   <tag and image ID> --public-layer <observed> --evidence <sanitized receipts>` and verify it with
   `npm run handoff:verify -- --zip <zip> --commit D`. A released package carries no instruction to
   merge or deploy its own source commit; it states the runtime commit and links here.

## 6. What this runbook does not cover

Production cutover (separate identity, capability and institutional gates), Profile A on-demand
executor releases (registration and image digest; see the
[zero-cost assistive executor](zero-cost-assistive-executor.md)), live Duda publication, and any
step that needs institutional authorisation. Nothing in this runbook has been executed against the
hosted environment as part of the closure candidate; it documents the contract the code enforces.
