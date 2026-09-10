# Participant Preview Reminder Runner

**STATUS:** Mechanism implemented; activation remains institution-controlled
**PURPOSE:** Operations

This is the focused operational contract for the provider-neutral participant-preview reminder
runner. It does not approve an SMTP provider, a sender domain, a production target, or an owner.

## Root cause closed by this mechanism

The reminder schedule, notification ledger, and email lifecycle already existed and were tested.
The original command was local-only, and the later hosted runner remained staging-only. An SMTP
arrangement by itself therefore could not make production reminders run after handover because no
production-qualified process could claim due schedules.

This change adds the missing execution plumbing without changing the schedule schema, preview token
handling, notification ledger, message content, or delivery state machine.

## Supported architecture

Build the image locally on one School/user-owned Docker host and run exactly one service instance:

```text
Docker process (no HTTP ingress)
  -> fail-closed identity/enablement/SMTP gate
  -> one bounded reminder pass
  -> PostgreSQL claim_due + existing notification state machine
  -> approved SMTP arrangement, when enabled
```

The process polls at a bounded interval (default 60 seconds; 5 seconds to 15 minutes when
configured), waits for the current pass to finish on `SIGTERM`/`SIGINT`, and then stops without
claiming another reminder. Database `FOR UPDATE SKIP LOCKED` and the existing notification
idempotency/lease rules remain the concurrency backstop. Horizontal scaling is not a supported
profile; run one instance only.

There is no listening port, HTTP health endpoint, public URL, cloud scheduler, or paid platform. The
built runner image need not be published to a public container registry; it is built from the
reviewed repository commit and can remain on the School host.

## Configuration gate

The example file at
[`infra/participant-reminders/participant-reminders.env.example`](../../infra/participant-reminders/participant-reminders.env.example)
contains variable names only. Populate an approved secret/configuration file outside the repository.
The runner is send-capable only when all of the following are true:

- `CAPSTONE_RUNTIME_ENV=staging`.
- `CAPSTONE_EXPECTED_SUPABASE_HOST` is the exact approved Supabase hostname.
- `CAPSTONE_EXPECTED_SUPABASE_PROJECT_REF` is the exact 20-letter project ref for that hostname.
  Compose injects this independently from the env file so changing the env-file hostname cannot
  relabel the mutation target.
- `CAPSTONE_STAGING_MUTATION_CONFIRMATION` is a valid existing staging mutation-confirmation label.
  This is an operator acknowledgment, not cryptographic evidence of target identity. Compose also
  injects it independently from the env file.
- `PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL` is the canonical HTTPS Supabase base URL and matches
  that expected host and project ref; loopback, credentials, ports, paths, queries, fragments, and
  lookalike hosts are refused.
- `SUPABASE_SECRET_KEY` is the approved modern server secret. The legacy service-role variable is
  not accepted in this dedicated runner profile.
- `PARTICIPANT_PREVIEW_REMINDERS_ENABLED=true`.
- `PARTICIPANT_PREVIEW_EMAIL_ENABLED=true` and the complete existing participant SMTP configuration
  is present: host, port, secure flag, From address, and either both SMTP auth values or neither.
  Hosted transport always requires encryption: `PARTICIPANT_PREVIEW_EMAIL_SMTP_SECURE=true` uses
  implicit TLS, while `false` is accepted only with Nodemailer `requireTLS` STARTTLS enforcement
  (ordinary institutional port 587 remains supported).

Those bullets remain the unchanged staging profile. Production uses the additive
`compose.production.yaml` and `participant-reminders.production.env.example`, with:

- `CAPSTONE_RUNTIME_ENV=production` and the same canonical actual-URL-to-expected-host checks;
- an independent exact 20-letter `CAPSTONE_EXPECTED_SUPABASE_PROJECT_REF` matching that host;
- `CAPSTONE_PRODUCTION_REMINDERS_ENABLED=true` exactly, in addition to the existing reminder and
  email flags; and
- a valid bounded `CAPSTONE_PRODUCTION_REMINDERS_ACKNOWLEDGEMENT` label instead of the staging
  mutation confirmation.

The production capability and acknowledgement are injected independently by its Compose profile.
Missing, false, padded, or case-varied capability values fail closed. A staging flag or staging
acknowledgement cannot authorize production, and the production values do not authorize staging.

The optional `PARTICIPANT_PREVIEW_REMINDERS_POLL_INTERVAL_MS` is bounded to 5,000–900,000 ms. The
optional `PARTICIPANT_PREVIEW_REMINDERS_BATCH_LIMIT` is bounded to 1–50 and defaults to 20. The
runner claims one item at a time inside that total batch bound, preserving the existing short
notification lease behaviour.

If reminders or SMTP delivery are disabled, the process stays idle and non-sending. It does not
construct a Supabase client, claim due work, send mail, or mutate schedule state. If sending is
requested with incomplete SMTP, invalid identity, or an invalid credential, startup reports only a
bounded reason code and exits non-zero; it does not expose configuration values or send anything.
Runtime pass logs contain only fixed state codes and aggregate counters. They never contain
credentials, recipient addresses, preview tokens, rendered messages, or private URLs.

## Build and run

From the repository root, using a reviewed commit:

```bash
docker build \
  -f infra/participant-reminders/Dockerfile \
  -t capstone-participant-preview-reminders:<reviewed-commit> \
  .
```

Prepare the populated environment file through the School's approved secret procedure, outside the
repository. Then start one Compose service:

```bash
CAPSTONE_EXPECTED_SUPABASE_PROJECT_REF=<exact-20-letter-ref> \
CAPSTONE_STAGING_MUTATION_CONFIRMATION=<configured-label> \
PARTICIPANT_PREVIEW_REMINDERS_ENV_FILE=<approved-env-file> \
  docker compose -f infra/participant-reminders/compose.yaml up -d
```

On Windows PowerShell, set the two guard values and the Compose interpolation variable in the
process environment before running the command. Do not place SMTP or Supabase values in command
arguments, source, or logs.
`restart: on-failure` is a host restart policy for an unexpected process failure; it is not a second
runner and does not authorize horizontal replicas.

Safe local packaging checks are:

```bash
PARTICIPANT_PREVIEW_REMINDERS_ENV_FILE=participant-reminders.env.example \
  docker compose -f infra/participant-reminders/compose.yaml config
npm run test:run --workspace=apps/admin-cms -- src/reminders/hostedParticipantPreviewReminderConfig.test.ts src/reminders/hostedParticipantPreviewReminderLoop.test.ts src/reminders/hostedParticipantPreviewReminderLog.test.ts src/reminders/hostedParticipantPreviewReminderPackaging.test.ts src/scripts/runHostedParticipantPreviewReminders.test.ts
npm run build:participant-preview-reminder-runner
```

The production Compose candidate must be selected explicitly and supplied all three independent
host guards. Repository checks use synthetic values only. No Docker start, real SMTP delivery,
hosted target access, or production activation is part of code qualification.

The Local SMTP sink runtime remains the test boundary for actual message composition and delivery
outcomes. It must be used instead of a real SMTP server for repository verification.

## Activation after an approved SMTP arrangement exists

Activation requires all external inputs below; code completion alone is not activation:

1. The institution approves the sender domain, From address, SMTP policy, credential storage, and
   incident/rotation owner.
2. The database/infrastructure owner supplies the exact staging Supabase host, canonical private URL,
   and modern server secret through the approved secret channel.
3. The technical owner populates the external env file with the two exact `true` flags and the
   complete SMTP variables, then builds the image from the reviewed commit.
4. The owner starts exactly one Compose service on the School/user-owned Docker host and checks only
   the bounded runner state/counter logs plus the existing database/admin evidence. No recipient or
   secret is copied into evidence.
5. Supervised synthetic staging/UAT verifies one eligible due reminder through the Local SMTP-sink
   equivalent test boundary before any real participant communication is considered.

To pause delivery, set the reminder or email flag false in the approved environment and restart the
service. Existing scheduled rows remain scheduled; staff can cancel or reschedule through the normal
workflow. To stop the host process, use the host's graceful container stop so the current fenced
operation can settle truthfully.

## What this proves and what remains blocked

This work proves that provider-neutral staging and disabled-by-default production runner profiles
exist and that their hosted process boundaries are fail-closed and testable. Neither profile grants
publication, database migration, or historical rollback authority. It does not prove production
email delivery, SMTP reachability, sender-domain approval, institutional policy, human UAT, uptime,
monitoring, backups, or institutional ownership. Those remain external acceptance and handover
blockers until the School supplies and records them through its approved process.
