# School-owned continuous assistive worker

**Status:** Repository deployment profile

**Scope:** Exactly one continuous Profile B worker on a School/user-controlled Docker host

**Ingress:** None

**Registry:** None; the image is built from the reviewed local checkout

This is the focused handoff for the local-use, no-public-redistribution assistive executor. It does
not change OCR, LanguageTool, duplicate detection, queue fencing, review, or publication authority.
Assistive failure remains non-blocking: core editing, review, and publication workflows continue
without this worker. The repository records an engineering deployment boundary, not legal advice;
the institution remains responsible for its licence review and local-use decision.

## Host prerequisites

- A Linux Docker host controlled by the School or its nominated maintainer.
- Docker Engine with the Compose v2 plugin and Git. Start with 2 CPUs and 4 GiB RAM for the worker;
  these are operational allocation defaults pending acceptance on the chosen host, not proven hard
  minimums.
- Outbound HTTPS access to the approved staging Supabase hostname. No inbound firewall rule, proxy,
  DNS record, TLS certificate, or published port is required.
- The reviewed repository checkout at the exact commit that will be deployed.
- The staging server secret supplied through the School's approved secret procedure.

Do not publish this image to a registry. It contains the qualified PP-OCRv6 Small and LanguageTool
artifacts, whose hashes remain enforced during the local build.

## Prepare the local environment

Create the runtime environment file **outside the repository** and therefore outside the Docker
build context. For example, from the repository root:

```sh
sudo install -d -m 700 /etc/capstone
sudo install -m 600 infra/assistive-worker/worker.env.example \
  /etc/capstone/assistive-worker.env
```

Replace every placeholder in `/etc/capstone/assistive-worker.env`. Use the canonical Supabase API
hostname (for example, a project-qualified `*.supabase.co` host), the matching `https://` base URL,
a unique stable identifier for this host, the 40-character lowercase commit from `git rev-parse
HEAD`, and `SUPABASE_SECRET_KEY`. Never paste the file or its values into logs, tickets, commits, or
shell command arguments.

Do not create or copy a populated `.env` anywhere under the repository. `.dockerignore` excludes
`.env` and `.env.*` at every depth as defence in depth, while the supported verifier also rejects
any runtime env path inside the repository or selected build context. Builds use a temporary
`git archive HEAD` context containing tracked committed bytes only.

An earlier draft of this handoff placed the runtime env file under `infra/assistive-worker` while
the Dockerfile used `COPY . .`. If any real image was built from that draft with a populated file,
treat the secret as potentially embedded: delete that image and all derived containers/caches under
the institution's procedure, rotate the server secret, and recreate the external file. This
runbook does not claim those actions have occurred.

The Compose definition fixes these reviewed runtime values without source changes:

- staging runtime and hosted execution enabled;
- `CONTINUOUS` mode;
- the frozen Paddle model directory;
- the frozen LanguageTool 6.6 archive and server JAR;
- starting allocations of two CPUs and 4 GiB memory, one service at scale one, no ports, an
  explicit unprivileged `1000:1000` runtime user,
  `pull_policy: never`, `unless-stopped` restart, and a ten-minute graceful-stop allowance.

## Level 1: offline/local acceptance

The verifier reads values without sourcing the external file and never prints the secret. Run its
self-tests first. Configuration verification requires the deployment version to be a valid full
40-hex local commit equal to `HEAD`; it also rejects a secret file inside the repository/build
context, missing variables, placeholders, mismatched Supabase identity, more than one service,
published ports, a privileged runtime user, incorrect mode, scale, pull policy, or restart policy.

```sh
sh infra/assistive-worker/verify.sh self-test
sh infra/assistive-worker/verify.sh config /etc/capstone/assistive-worker.env
sh infra/assistive-worker/verify.sh image /etc/capstone/assistive-worker.env
```

Image verification additionally rejects any staged change, unstaged tracked change, or relevant
untracked file before building. It exports committed `HEAD` with `git archive`, then builds
`Dockerfile.hosted` locally from that clean temporary context. The build downloads the
already-qualified artifacts from their frozen upstream locations and fails on any hash mismatch;
this is build-time network access, not a cloud deployment or registry publication. The verifier
requires the image's OCI revision label to match the commit and records its immutable `sha256:`
image ID in `/etc/capstone/assistive-worker.env.image-acceptance.<commit>`.

If an offline build cache does not contain the base image, packages, and qualified artifacts, only
the configuration check can run fully offline. Record that limitation rather than claiming an image
build passed.

## Start and verify the host

```sh
export CAPSTONE_ASSISTIVE_WORKER_ENV_FILE=/etc/capstone/assistive-worker.env
export CAPSTONE_ASSISTIVE_WORKER_BUILD_CONTEXT="$(pwd)"

docker compose \
  --project-directory infra/assistive-worker \
  --env-file "$CAPSTONE_ASSISTIVE_WORKER_ENV_FILE" \
  -f infra/assistive-worker/compose.yaml \
  up -d --no-build

sh infra/assistive-worker/verify.sh running /etc/capstone/assistive-worker.env
```

The running check proves one unprivileged container and no Docker port bindings. It reads the prior acceptance
record, requires the mutable local tag still to resolve to that immutable image ID, and separately
requires the running container's Docker `.Image` ID and revision label to match. It deliberately
does not call Supabase and does not equate a running container with application readiness.

The worker performs its existing database/Python/LanguageTool preflight before publishing `READY`.
It then publishes a compatible heartbeat every 15 seconds. On `docker compose stop`, SIGTERM reaches
the Node coordinator directly; it stops claiming work, finishes the current fenced operation,
publishes `STOPPING`, and exits within the ten-minute Compose grace period. `unless-stopped` restarts
the worker after a host or process failure but respects an intentional operator stop.

Use ordinary `docker compose logs worker` only for bounded troubleshooting. The worker emits bounded
outcomes and generic failures, not credentials or participant content. Do not print `docker compose
config`, inspect the container environment, or enable shell tracing because those actions can expose
the external secret.

## Level 2: staging operational acceptance

Only an authorised orchestrator with governed staging access can complete this level. After starting
the worker, it must:

1. Confirm the Admin/CMS expected deployment version equals the same 40-character commit and hosted
   assistive execution remains enabled.
2. Use the governed worker-availability routine or Admin surface to record a fresh compatible
   heartbeat for that deployment. A container that is merely `running` is not evidence of readiness.
3. Enqueue bounded representative staging work through the existing authorised workflow and record
   the complete action-to-visible-result boundary. Capture p50 and p95; the existing PP1 acceptance
   target is p95 under three minutes on an accepted host and under 90 seconds on recommended
   hardware. Host resource qualification remains part of this acceptance.
4. Confirm assistive failure remains non-blocking by stopping the worker, allowing the heartbeat to
   become unavailable, and verifying the core workflow remains usable without automatic publication.

Do not manufacture or backdate heartbeat or latency evidence. Historical hosted runs and the stale
heartbeat from an older deployment do not satisfy current acceptance.

## Routine operation and replacement

Use `docker compose stop` to pause and the same `up -d --no-build` command to resume. Queued jobs wait
and existing lease recovery handles interrupted work. Never clear claim tokens or delete queue rows.

Treat every upgrade or rollback as one coordinated Admin/CMS and worker maintenance operation:

1. Keep the current Admin expected deployment identity and worker running while the replacement is
   built and accepted from its clean reviewed checkout.
2. Announce a temporary assistive-only unavailability window, then stop the old worker so two
   continuous workers never overlap.
3. Deploy Admin/CMS with `CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION` set to the replacement
   commit, keeping hosted assistive execution enabled and all other compatibility identities intact.
4. Set the external worker env file to that same commit, start the already accepted local image with
   `--no-build`, and run `verify.sh running` against its commit-specific acceptance record.
5. Wait for a fresh compatible heartbeat before declaring assistive processing ready. Core workflow
   remains available during the transition.

Rollback follows the same order using a previously accepted compatible commit and its immutable
image record. Never perform a worker-only version transition, overlap workers, or roll database
migrations back through this profile.

Rotate the server secret by stopping the worker, replacing the external environment file through
the approved secret procedure, restoring owner-only permissions, and starting it again. Remove the
external file and its acceptance records when the host is decommissioned.

## What remains institutional

The repository package removes the Profile A cloud subscription and public-image redistribution
dependencies. It cannot supply the School-controlled Docker host, staging server secret, outbound
network approval, Admin/CMS expected-version deployment, or authorised staging acceptance evidence.
Those remain explicit orchestrator/institution responsibilities.
