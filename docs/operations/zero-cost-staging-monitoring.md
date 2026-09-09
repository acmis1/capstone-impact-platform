# Zero-Cost Staging Monitoring

**STATUS:** Implemented and tested repository signal with durable GitHub incident retention

## Purpose and boundary

The active staging Admin/CMS is the Render Free web service
`capstone-admin-cms-staging-v2`. Render's native health-check path is already
`/api/readiness`, and the application also exposes `/api/health` for liveness.
Those routes and the existing hosted smoke verifier are repository-tested. The
recurring repository-owned signal below makes a sustained failure visible as a
failed workflow run and retains a bounded repository-owned incident record in
GitHub Issues, failing closed on ambiguity.

Render's `notifyOnFail=default` setting is not evidence that an institution-owned
recipient receives a notification. The GitHub issue record is technical
repository retention only. This document does not claim email or Slack
delivery, named recipients, human acknowledgement, escalation, an approved
retention policy, an operational SLA, or production monitoring.

## Implemented monitor

`.github/workflows/zero-cost-staging-monitoring.yml` runs the zero-dependency
Node probe in `tools/zero-cost-staging-monitoring/monitor.mjs`.

The workflow:

- supports `workflow_dispatch` for an explicit manual run;
- runs on a sparse six-hour schedule (`17 */6 * * *`), deliberately avoiding
  minute 0;
- uses only a public-repository GitHub Actions standard hosted runner;
- grants only `contents: read` and `issues: write`, and prevents overlapping
  runs;
- probes only `HEAD /api/health` and `HEAD /api/readiness` on the fixed public
  staging origin;
- treats exactly HTTP 200 from both endpoints in one attempt as convergence;
- retries transient startup, 503, 5xx, and transport failures for at most five
  attempts with a 15-second delay between attempts;
- gives each request a 10-second timeout and fails non-zero when the bounded
  window does not converge; and
- prints only endpoint paths, safe status/code values, and attempt counts.

After the probe outcome is known, the workflow runs
`tools/zero-cost-staging-monitoring/incident-ledger.mjs` with the GitHub API
through `gh`:

- the incident is identified only by the fixed workflow-owned label
  `zero-cost-staging-monitoring`, exact title
  `[staging-monitor] Public staging endpoint failure`, and fixed body marker;
- a sustained failure creates or updates the owned open issue with bounded
  allowlisted facts; a failed run resets any pending recovery confirmation, and
  a previously recovered owned issue is reopened for a later failure when
  discovery finds that record;
- a full monitor `PASS` on an owned open incident records a durable
  `Recovery confirmations: N/3` counter in the issue body. The first and
  second consecutive full passes keep the issue open; only the third closes it
  as `RECOVERED`. A `PASS` with no open incident is a no-op;
- issue discovery lists repository issues through the Issues API using the
  workflow-owned label and `state=all`, follows bounded pages, and validates
  the exact title, label, and body marker. Duplicate owned matches,
  labelled-but-unowned collisions, or a pagination boundary that cannot be
  proven complete fail closed before issue mutation; and
- an API, workflow-summary, or issue-management problem never claims recovery.
  A malformed or unavailable probe summary is treated conservatively as
  `FAIL`, while an issue-management API failure fails the workflow and records
  no successful ledger result.

The probe step uses `continue-on-error` only so incident bookkeeping still runs
after a failed probe. A final result-enforcement step checks the raw `outcome`
of both the probe and ledger steps plus the parsed, full-PASS monitor summary,
and exits non-zero unless all are valid. Consequently, a sustained outage can
create or update its issue before the job finishes red; a malformed summary or
ledger failure also finishes red; only a successful probe with a valid full
PASS summary plus successful no-op or recovery bookkeeping remains green.

Issue bodies contain only fixed text, the two public endpoint paths, bounded
attempt counts, the bounded recovery counter, and allowlisted HTTP status/code
values. They contain no response bodies, URLs, query strings, headers, cookies,
credentials, user identities, or private data. The issue's GitHub history and
machine-owned counter are the durable repository-owned technical record; human
delivery, acknowledgement, and any institution-approved retention period
remain separate decisions.

### Identity and race boundary

The fixed label, exact title, and exact body marker define the workflow-owned
identity. A public issue that merely squats on the title without the owned
label is ignored; a labelled issue with the title but without the exact marker
fails closed. Listing is bounded to ten 100-issue pages; an apparently full
final page is not treated as complete, and more than the bound fails closed.
The workflow concurrency group is a secondary guard for its own scheduled and
manual runs. GitHub issue creation is not a transaction with discovery, so a
separate external actor could still race creation between those operations.
That bounded residual is not claimed to be impossible; a later run detects
multiple owned matches and fails closed rather than selecting one.

The maximum normal convergence window is bounded: five 10-second request
attempts with four 15-second gaps, or about 110 seconds plus small scheduling
overhead. A first 503 or connection failure is therefore treated as a possible
cold-start/transient result, not an immediate incident. A sustained failure
still produces a failed GitHub Actions run and the bounded incident record.

## Free-tier and sleep behavior

The six-hour cadence is deliberately much sparser than the Render Free
15-minute inactivity spin-down window. A scheduled probe can wake the service
for that check, but the next scheduled probe is many hours later, so this
workflow cannot keep the service awake across the inactivity window. It does
not use a paid monitor, a paid Render plan, a Render cron/background worker,
an always-on workload, an API key, or a mechanism intended to simulate
continuous availability.

The probe has no runtime dependency on the Admin/CMS. If GitHub Actions is
unavailable, the application remains independent and continues to function;
the repository signal is simply absent for that run.

## GitHub scheduling boundary

GitHub scheduled workflows are best-effort automation, not an SLA. GitHub may
delay a scheduled run or occasionally drop it, especially during high-load
periods around the beginning of an hour. The workflow deliberately schedules at
minute 17 to reduce that documented minute-0 scheduling risk while preserving
the six-hour frequency.

Because this is a public repository, GitHub may automatically disable the
scheduled workflow after 60 days without repository activity. Before relying
on this signal after a long inactive period, an operator must confirm that the
workflow remains enabled and re-enable it if necessary. `workflow_dispatch` is
available for an enabled workflow; it does not bypass GitHub's disabled-workflow
state.

## Safety boundary

The probe accepts only an HTTPS origin without URL userinfo, query, fragment,
or path. It sends no credentials, cookies, secret headers, request body, or
state-changing request. Redirects are rejected rather than followed. Request
timeouts and retries are bounded. Response bodies are never read or written to
workflow logs. Unexpected statuses and transport results fail closed.

It does not call `/api/publish-cloud-feed`, Duda, Supabase, login, private
routes, or any mutation endpoint.

## Tests

The dedicated Node test suite uses mocked fetch responses and mocked issue API
calls; it does not contact the live staging URL or GitHub:

```text
node --test tools/zero-cost-staging-monitoring/monitor.test.mjs tools/zero-cost-staging-monitoring/incident-ledger.test.mjs
```

It covers immediate health, transient readiness convergence, sustained 503 and
5xx failures, transport failure, timeout, redirect rejection, unsafe URLs,
bounded retries, request shape, response-body non-disclosure, first/repeated
failure, duplicate or ambiguous lookup, three-run recovery and flapping, no
incident, API failure, paginated/truncated issue discovery, sanitized output,
identity collisions, idempotency, static workflow guardrails, and final
workflow status propagation.

## Claim boundary and follow-up

Implemented and tested by this change:

- a repository-owned zero-cost HTTP monitoring probe;
- bounded cold-start handling and deterministic non-zero failure;
- manual and sparse scheduled execution;
- minimal workflow permissions and non-overlapping runs;
- free-tier-safe, read-only staging behavior; and
- a bounded, idempotent GitHub issue incident record for failure and three-run
  recovery, with fail-closed duplicate handling.

Not proved or delivered by this change:

- email, Slack, or any other notification delivery;
- an institution-owned notification target or escalation route;
- human alert acknowledgement or response;
- an institution-approved retention policy or retention period beyond the
  repository's GitHub issue history;
- production monitoring or an operational SLA;
- formal RPO/RTO; or
- authenticated workflow monitoring and data/schema evidence.

An institution-approved recipient and delivery test remain required before an
open issue or failed workflow can be treated as an acknowledged operational
alert. GitHub scheduling is not institutionally guaranteed monitoring, and the
existing M6 monitoring contract remains the authority for alert-delivery,
retention-policy, and operational decisions.
