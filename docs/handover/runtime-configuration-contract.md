# Runtime configuration contract

**Source-reviewed:** 10 September 2026
**Scope:** current integration baseline at `21d577e`
**Status:** implementation and configuration handoff; not a deployment record or institutional authorization

This document is the source-backed reference for runtime and deployment configuration. The
committed code, tests and exact release identity remain authoritative. Never put populated
environment files, credentials, private URLs, tokens or participant identifiers in the repository,
tickets or logs.

The staging web deployment inventory is
[`infra/deployment/admin-cms-staging.manifest.yaml`](../../infra/deployment/admin-cms-staging.manifest.yaml).
Its `environment` section is owner configuration and its `platformEnvironment` section is
provider-injected Render identity. The manifest is intentionally manual, staging-only and
disabled-by-default. `apps/admin-cms/.env.example` is a web/operator example, not a worker or
reminder-runner profile.

## 1. Read the states separately

| State | Current truth |
| --- | --- |
| Implemented | Explicit production configuration paths exist for the hosted continuous assistive worker and participant reminder runner. Their production capabilities are independently gated. Migration 56 (`20260910120200_assistive_worker_production_identity.sql`) carries the exact `staging`/`production` heartbeat identity and refuses cross-environment relabelling of an existing worker instance. |
| Enabled | No capability is enabled by the committed examples or staging manifest. Production controls default to false and require exact values where the resolver requires them. |
| Deployed | The committed deployment artifact is a staging Render reconciliation manifest only. It keeps automatic deployment off and does not prove that a running service, worker or runner has adopted this release. |
| Authorized | No flag, configured SHA, image digest, manifest, build or test supplies institutional authorization. Real production infrastructure, SMTP/domain/provider approval, ownership transfer and final cutover remain external decisions. |

AI, OCR, language checking and duplicate detection remain assistive-only. They have no approval,
publication or autonomous project-mutation authority.

## 2. Process ownership

| Process/profile | Configuration belongs here | Important boundary |
| --- | --- | --- |
| Admin/CMS web runtime | Core Supabase, auth, buckets, staging guards, web capability flags, notification settings and optional worker compatibility expectations | This is the only process described by the staging Render manifest. |
| Render provider identity | `RENDER`, `RENDER_GIT_COMMIT`, `RENDER_EXTERNAL_URL` | Render injects these. They are observed, never copied into owner configuration. |
| Continuous assistive worker | Hosted worker target, server secret, worker identity, deployment identity and frozen OCR/LanguageTool artifact paths | One continuously running worker publishes bounded heartbeats. Production is continuous-only. |
| Staging on-demand dispatcher | Dedicated session-pooler database URL, deployment/image identities and Azure managed identity/target values | It only dispatches staging on-demand work. It does not perform OCR and is not a production fallback. |
| Participant reminder runner | Dedicated Supabase target/ref, reminder and email gates, SMTP settings, polling/batch bounds and environment acknowledgement | One no-ingress runner instance is supported. It is separate from the web manifest. |
| Production capability controls | `CAPSTONE_PRODUCTION_*` values in the process profile that consumes them | Implemented does not mean enabled, deployed or institutionally approved. |
| Local/disposable verifiers | Loopback and verifier-owned target, port, workdir and disposable acknowledgements | These are not hosted service configuration and must not be copied into a web deployment. |

## 3. Admin/CMS web runtime

Sources include `apps/admin-cms/src/lib/env.ts`, `lib/supabaseCredential.ts`,
`security/stagingRuntimeIdentity.ts`, publication and rollback policy modules, the notification and
reminder route/configuration modules, and the corresponding tests.

| Variable | Default, parsing and requiredness | Owner, scope and fail-closed behavior |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Required by `getPublicEnv`; must be a valid URL. Hosted target checks additionally require the exact canonical HTTPS base URL. No default. | Owner-selected Supabase project; browser-visible. Missing, malformed or identity-mismatched values make the web runtime not ready. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Preferred browser credential. A non-empty `sb_publishable_*` suffix or a legacy anon JWT payload role is required when selected. | Owner config; browser-visible, never a server secret. Unsafe credentials are rejected. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Legacy browser credential alternative. It is independently classified as an anon JWT when selected. No default. | Owner config; browser-visible. Unsafe credentials are rejected. |
| `SUPABASE_SECRET_KEY` | Preferred server credential. A non-empty `sb_secret_*` suffix is required when selected. | Owner secret store; server-only. The web runtime prefers this over the legacy fallback. |
| `SUPABASE_SERVICE_ROLE_KEY` | Legacy server credential fallback; a service-role JWT is required when selected. No default. | Owner secret store; server-only. Dedicated hosted worker/reminder profiles do not use this fallback. |
| `CAPSTONE_AUTH_FLOW_SECRET` | Independent server-only signing secret; operational contract requires at least 32 random bytes. No default. | Owner secret store; server-only. Password-recovery context fails closed without it. |
| `CAPSTONE_RUNTIME_ENV` | No inferred hosted default. Hosted identity uses exact, case-sensitive `staging` or `production`; Local rollback uses normalized `local`. | Operator configuration. Unknown, missing, padded or case-varied hosted identity is not accepted. |
| `CAPSTONE_EXPECTED_SUPABASE_HOST` | No default. Must be the exact hostname only: no scheme, path, port or trailing dot. | Owner target configuration; server-only. The actual Supabase URL must match it exactly or hosted operations fail closed. |
| `CAPSTONE_STAGING_MUTATION_CONFIRMATION` | No default. A 1–64 character lower-case label matching `[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?`; it is not cryptographic target proof. | Owner/operator staging configuration. Required by mutating staging guards and the staging reminder runner, but not by read-only operations. |
| `SUPABASE_DRAFT_BUCKET` | Defaults to `project-drafts-private`; an explicitly empty value is invalid. | Server storage configuration. |
| `SUPABASE_PUBLIC_ASSETS_BUCKET` | Defaults to `project-public-assets`; an explicitly empty value is invalid. | Server storage configuration. |
| `SUPABASE_PUBLIC_FEEDS_BUCKET` | Defaults to `public-feeds`; an explicitly empty value is invalid. | Server/publication storage configuration. |
| `SUPABASE_PUBLIC_FEED_FILE` | Defaults to `capstones-latest.json`; an explicitly empty value is invalid. | Server/publication path configuration. |
| `GEMINI_API_KEY` | Optional; `getOptionalGeminiEnv` returns a disabled fallback if optional parsing fails. | Owner secret store for the optional assistive adapter; not a hosted production dependency. |
| `GEMINI_MODEL` | Defaults to `gemini-2.5-flash`. | Optional assistive adapter configuration. |
| `GEMINI_ASSISTIVE_EXTRACTION_ENABLED` | Defaults false. The current transform compares `value.toLowerCase()` to `true`; it does not trim whitespace. | Server-only optional assistive control. A missing/false value leaves extraction disabled. |

The staging manifest requires the modern publishable and server secret names. The application still
supports both legacy credential names for compatibility, but the staging manifest does not turn
legacy fallback into an additional required hosted setting.

## 4. Provider identity and web capability gates

The three Render variables are listed only under `platformEnvironment` in the manifest. Their
values remain `null` in committed configuration because the platform supplies them at runtime.

| Variable | Exact semantics and consumer |
| --- | --- |
| `RENDER` | Provider marker. Readiness, CSRF and Render-alias heartbeat logic require exact `true`; a manually populated value is not provider evidence. |
| `RENDER_GIT_COMMIT` | Provider-injected deployed commit. Readiness requires a valid 40-hex commit together with the provider marker. The hosted worker resolver accepts it as a legacy alias only when the canonical `CAPSTONE_DEPLOYMENT_VERSION` is absent; heartbeat identity accepts that alias only with `RENDER=true`. A provider-neutral host must supply the canonical variable instead. |
| `RENDER_EXTERNAL_URL` | Provider-injected canonical public origin used for external links and Render-origin checks. Forwarded or Host headers are not substitutes. |
| `NODE_ENV` | Framework/process value. It affects framework behavior such as Secure recovery cookies; it is not the PP1 staging/production target selector. |
| `PORT` | Hosting-provider or local launcher listening port. It does not identify the Supabase target. |
| `CAPSTONE_STAGING_MAINTENANCE_MODE` | Exact `true` enables the deny gate; only exact GET/HEAD requests to `/api/health`, `/api/readiness` and `/login` remain allowed. Absent/false means maintenance is disabled. |
| `STAFF_PROVISIONING_ENABLED` | Defaults disabled; trimmed, case-normalized `true` gates creation of new invitations only. Existing valid pending invitations can still activate. |
| `CAPSTONE_STAGING_PUBLICATION_ENABLED` | Defaults disabled; exact `true` plus verified staging identity is required for staging publication/removal. |
| `CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED` | Defaults disabled; exact `true` plus verified staging identity and the separate exact-head database capability/administrator evidence is required. |
| `CAPSTONE_PRODUCTION_PUBLICATION_ENABLED` | Defaults disabled; exact `true` plus verified production identity is required for production publication. It does not enable historical production rollback. |
| `CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED` | Defaults disabled; exact `true` is only a prerequisite for hosted assistive execution. Verified target, deployment identity, worker compatibility and the appropriate execution-control checks remain required. |
| `CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED` | Defaults disabled; exact `true` is an additional production-only capability gate for both the production continuous worker and its Admin/CMS availability consumer. It does not enable staging or Azure production dispatch. |
| `CAPSTONE_PRODUCTION_REMINDERS_ENABLED` | Defaults disabled; exact `true` is an additional production-only gate consumed by the hosted reminder runner. It is not a staging web-manifest requirement. |
| `CAPSTONE_PRODUCTION_REMINDERS_ACKNOWLEDGEMENT` | Production reminder-runner acknowledgement. It must be a valid bounded lower-case label and is used instead of the staging mutation-confirmation label. It is an acknowledgement, not target authentication. |

The staging manifest keeps `productionCutover`, `liveDudaPublication`, `autoDeploy` and all
staging capability values false. It intentionally does not require production capability values,
worker-only secrets, reminder-runner-only target/ref values or Azure dispatcher values.

## 5. Deployment identity and assistive execution

### Canonical deployment identity

`CAPSTONE_DEPLOYMENT_VERSION` is a provider-neutral, full 40-character lower-case commit identity.
It is required by the staging on-demand dispatcher and is the canonical identity for a
provider-neutral hosted worker. A hosted worker may use `RENDER_GIT_COMMIT` as a legacy alias when
the canonical variable is absent, but every populated identity must be an exact matching SHA.
The dispatcher does not accept the Render alias: it requires `CAPSTONE_DEPLOYMENT_VERSION`.

The Admin/CMS web-side expectations are different variables:

- `CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION` is the expected worker SHA used when
  matching compatible heartbeat or on-demand evidence.
- `CAPSTONE_ASSISTIVE_EXPECTED_WORKER_IMAGE_DIGEST` is the expected immutable `sha256:` image
  digest used by staging on-demand availability checks.

Neither expected value proves that a worker is deployed. A fresh compatible heartbeat or the
separate staging execution-control evidence is still required, and a configured SHA never proves
provider adoption. Changing an identity requires restarting/redeploying the affected process and
then checking observed readiness/evidence against the intended release.

### Continuous worker profile

The hosted worker resolver (`hostedAssistiveWorkerConfig.ts`) requires:

| Variable | Requirement |
| --- | --- |
| `CAPSTONE_ASSISTIVE_SUPABASE_URL` | Required canonical target URL. The URL is rebound through the selected exact staging or production runtime identity check. |
| `SUPABASE_SECRET_KEY` | Required modern server secret. The hosted worker has no legacy service-role fallback. |
| `CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID` | Required bounded stable identity. `RENDER_INSTANCE_ID` is only a legacy alias when the canonical name is absent. |
| `CAPSTONE_RUNTIME_ENV` | Exact `staging` or `production`, with the matching expected host and target URL. |
| `CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED` | Exact `true`. |
| `CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED` | Exact `true` only for the separately qualified production profile. Not used to authorize staging. |
| `CAPSTONE_DEPLOYMENT_VERSION` / `RENDER_GIT_COMMIT` | Full lower-case 40-hex deployment identity as described above. |
| `CAPSTONE_ASSISTIVE_EXECUTION_MODE` | Absent defaults to exact `CONTINUOUS`; the other exact value is `ON_DEMAND`. Production rejects every mode other than `CONTINUOUS`. |
| `CAPSTONE_ASSISTIVE_PADDLE_MODELS_DIR` | Required absolute frozen artifact directory. |
| `CAPSTONE_ASSISTIVE_LANGUAGETOOL_ARCHIVE` | Required absolute path whose basename is `LanguageTool-stable.zip`. |
| `CAPSTONE_ASSISTIVE_LANGUAGETOOL_JAR` | Required absolute path whose basename is `languagetool-server.jar`. |

The production profile is implemented as an explicitly separate continuous path. It requires the
production runtime identity, the production capability gate and a continuously running worker that
publishes a compatible heartbeat. The Admin/CMS production availability path consults only the
production heartbeat identity and does not consult staging on-demand execution control.

### Staging on-demand dispatcher

The optional staging dispatcher additionally requires `CAPSTONE_ASSISTIVE_DISPATCHER_INSTANCE_ID`,
`CAPSTONE_ASSISTIVE_DISPATCHER_DB_URL`, `CAPSTONE_DEPLOYMENT_VERSION`,
`CAPSTONE_ASSISTIVE_IMAGE_DIGEST`, `AZURE_SUBSCRIPTION_ID`, `AZURE_CLIENT_ID`,
`AZURE_RESOURCE_GROUP`, `CAPSTONE_ASSISTIVE_WORKER_JOB_NAME`, `IDENTITY_ENDPOINT` and
`IDENTITY_HEADER`. The database URL must use the dedicated
`capstone_assistive_dispatcher.<project-ref>` session-pooler role on the approved Supavisor
session-pooler target; it is not a service-role URL. Cloud authority comes from the managed
identity endpoint/header, not a stored client secret.

An on-demand worker additionally receives the dispatcher-generated
`CAPSTONE_ASSISTIVE_RESERVATION_TOKEN` and positive
`CAPSTONE_ASSISTIVE_RESERVATION_GENERATION`, and must use the expected immutable
`CAPSTONE_ASSISTIVE_IMAGE_DIGEST`. Those values are per-launch execution controls, not ordinary
web configuration. The worker claims the reservation before constructing OCR/LanguageTool
providers, drains only the bounded execution window and settles evidence. Production must never
fall back to this staging on-demand path.

## 6. Participant reminder runner

The dedicated hosted runner is `apps/admin-cms/src/scripts/runHostedParticipantPreviewReminders.ts`.
Its configuration belongs in the external files under `infra/participant-reminders`, not in the
Admin/CMS staging manifest. It has no HTTP ingress, no public URL and no supported horizontal
replicas.

| Variable | Default, parsing and requiredness | Process/ownership |
| --- | --- | --- |
| `PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL` | Required when send-capable; canonical HTTPS base URL only. It must match the actual expected host, project ref and any supplied web/worker URL. | Reminder runner target configuration. |
| `CAPSTONE_EXPECTED_SUPABASE_PROJECT_REF` | Required when send-capable; exactly 20 lower-case letters and must be the hostname prefix. It is intentionally not a core web-app requirement and is not assigned in `apps/admin-cms/.env.example`. | Reminder runner target binding. |
| `PARTICIPANT_PREVIEW_REMINDERS_ENABLED` | Defaults disabled; trimmed, case-normalized `true` enables the scheduling path only. | Reminder runner and web scheduling route; no sending occurs without email configuration. |
| `PARTICIPANT_PREVIEW_REMINDERS_POLL_INTERVAL_MS` | Absent defaults to `60000`; explicit values must be integer text in `5000`–`900000`. Explicit blank is invalid. | Reminder runner process. |
| `PARTICIPANT_PREVIEW_REMINDERS_BATCH_LIMIT` | Absent defaults to `20`; explicit values must be integer text in `1`–`50`. | Reminder runner process. |
| `CAPSTONE_PRODUCTION_REMINDERS_ENABLED` | Production only; exact `true`. Missing, false, padded or case-varied values fail closed. | Production reminder-runner profile, independently injected. |
| `CAPSTONE_PRODUCTION_REMINDERS_ACKNOWLEDGEMENT` | Production only; valid lower-case bounded acknowledgement label. | Production reminder-runner profile, independently injected. |

Email transport values are `PARTICIPANT_PREVIEW_EMAIL_ENABLED`,
`PARTICIPANT_PREVIEW_EMAIL_SMTP_HOST`, `PARTICIPANT_PREVIEW_EMAIL_SMTP_PORT`,
`PARTICIPANT_PREVIEW_EMAIL_SMTP_SECURE`, `PARTICIPANT_PREVIEW_EMAIL_SMTP_USER`,
`PARTICIPANT_PREVIEW_EMAIL_SMTP_PASSWORD` and `PARTICIPANT_PREVIEW_EMAIL_FROM`.

- Email enablement is trimmed and case-normalized `true`; absent/false is disabled.
- Host, From, username and password are bounded, trimmed and control-character-free.
- Port is required integer text from 1 to 65535; there is no inferred SMTP port.
- SMTP username and password must be supplied together or both omitted.
- The hosted runner requires the secure flag to be explicitly trimmed/case-normalized `true` or
  `false`; it always sets `requireTLS: true`, so `false` means enforced STARTTLS rather than
  unencrypted delivery.

The production runner is send-capable only when the reminder flag, email flag, complete SMTP
configuration, modern `SUPABASE_SECRET_KEY`, exact production runtime/host/ref/URL identity,
production capability and production acknowledgement all pass. Disabled reminders or disabled
email are idle non-sending states and return before creating a Supabase client. Enabled-but-invalid
configuration returns a bounded reason and exits without sending. Logs do not include credentials,
recipient addresses, preview tokens, rendered messages or private URLs.

Production reminder support is therefore implemented, but it is not deployed or authorized merely
because these variables exist. The real SMTP arrangement, sender-domain approval, target project,
host, secret, one-instance host and institutional communication approval remain external gates.

## 7. Local and disposable controls

These values are intentionally absent from the hosted web example and staging manifest:

- `CAPSTONE_LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED` is a disposable-only normalized `true` gate and
  still requires normalized `CAPSTONE_RUNTIME_ENV=local` plus a loopback Supabase URL.
- `CAPSTONE_VERIFY_DISPOSABLE`, `CAPSTONE_VERIFY_SUPABASE_WORKDIR`,
  `CAPSTONE_VERIFY_SUPABASE_PROJECT_ID`, `CAPSTONE_VERIFY_PRESERVED_PUBLIC_ID` and
  `CAPSTONE_VERIFY_LEDGER_FOCUS` are bounded verifier inputs for disposable runtime checks.
- `CAPSTONE_GATE4_LOCAL_PROJECT_ID`, `CAPSTONE_GATE4_RUNTIME_PORT_BASE`,
  `CAPSTONE_LEDGER_RUNTIME_PORT_BASE`, `CAPSTONE_STAGING_UPGRADE_PORT_BASE` and
  `CAPSTONE_STAFF_LIFECYCLE_PORT_BASE` are verifier-owned local port/project controls.

Other child-process, Docker-proxy, parent-process and temporary-port values are internal launcher
controls. Do not persist them in a hosted web service environment or interpret them as permission
to access a hosted project.

## 8. Change, restart and acceptance procedure

For each configuration change, record the variable name, purpose, source/default, process scope,
intended environment, owner, affected release identity and check result—never the value of a
secret. Restart or redeploy the process that owns the variable, then verify health/readiness and
the specific negative/positive behavior. A valid env file, a false flag, a configured SHA, a
running container or a successful build alone is not runtime adoption evidence.

The source-specific flag semantics are intentionally not standardized here:

| Parsing family | Current examples |
| --- | --- |
| Exact `true` | `CAPSTONE_RUNTIME_ENV` identity comparisons; staging/production publication; staging rollback; hosted assistive execution; production assistive/reminder capabilities; maintenance mode. |
| Trimmed/case-normalized `true` | Staff provisioning, participant email, participant reminders, Local rollback and the hosted SMTP secure choice. |
| Lower-case comparison without trim | `GEMINI_ASSISTIVE_EXTRACTION_ENABLED`. |
| Exact bounded identity | Hosts, canonical URLs, project refs, full deployment SHAs, image digests and acknowledgement labels each retain their resolver-specific syntax. |

The executable contract is enforced by `checkDeploymentManifest.ts`,
`checkDeploymentManifest.test.ts` and `deploymentEnvironmentExample.test.ts`. Those checks prove
that required entries exist, fixed staging values remain exact, owner/secret values stay unpopulated,
Render identity stays provider-owned, consumer paths remain source-backed, staging capabilities
remain disabled, the web example matches the manifest once per variable, duplicate assignments fail,
and production/worker/reminder-only values do not silently become staging web requirements.
