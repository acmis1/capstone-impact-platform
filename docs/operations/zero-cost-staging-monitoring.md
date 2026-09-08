# Zero-Cost Staging Monitoring

**STATUS:** Implemented and tested repository signal

## Purpose and current gap

The active staging Admin/CMS is the Render Free web service
`capstone-admin-cms-staging-v2`. Render's native health-check path is already
`/api/readiness`, and the application also exposes `/api/health` for liveness.
Those routes and the existing hosted smoke verifier are repository-tested, but
the current repository did not have a recurring, repository-owned signal whose
failure is visible as a failed workflow run.

Render's `notifyOnFail=default` setting is not evidence that an institution-owned
recipient receives a notification. This document therefore describes a
technical workflow signal only. It does not claim email or Slack delivery,
named recipients, acknowledgement, escalation, an operational SLA, or
production monitoring.

## Implemented monitor

`.github/workflows/zero-cost-staging-monitoring.yml` runs the zero-dependency
Node probe in `tools/zero-cost-staging-monitoring/monitor.mjs`.

The workflow:

- supports `workflow_dispatch` for an explicit manual run;
- runs on a sparse six-hour schedule (`17 */6 * * *`), deliberately avoiding
  minute 0;
- uses only a public-repository GitHub Actions standard hosted runner;
- grants only `contents: read` and prevents overlapping runs;
- probes only `HEAD /api/health` and `HEAD /api/readiness` on the fixed public
  staging origin;
- treats exactly HTTP 200 from both endpoints in one attempt as convergence;
- retries transient startup, 503, 5xx, and transport failures for at most five
  attempts with a 15-second delay between attempts;
- gives each request a 10-second timeout and fails non-zero when the bounded
  window does not converge; and
- prints only endpoint paths, safe status/code values, and attempt counts.

The maximum normal convergence window is bounded: five 10-second request
attempts with four 15-second gaps, or about 110 seconds plus small scheduling
overhead. A first 503 or connection failure is therefore treated as a possible
cold-start/transient result, not an immediate incident. A sustained failure
still produces a failed GitHub Actions run, which is the repository-owned
monitoring evidence.

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

The dedicated Node test suite uses mocked fetch responses and does not contact
the live staging URL:

```text
node --test tools/zero-cost-staging-monitoring/monitor.test.mjs
```

It covers immediate health, transient readiness convergence, sustained 503 and
5xx failures, transport failure, timeout, redirect rejection, unsafe URLs,
bounded retries, request shape, and response-body non-disclosure.

## Claim boundary and follow-up

Implemented and tested by this change:

- a repository-owned zero-cost HTTP monitoring probe;
- bounded cold-start handling and deterministic non-zero failure;
- manual and sparse scheduled execution;
- minimal workflow permissions and non-overlapping runs; and
- free-tier-safe, read-only behavior.

Not proved by this change:

- email, Slack, or any other notification delivery;
- an institution-owned notification target or escalation route;
- human alert acknowledgement or response;
- production monitoring or an operational SLA;
- formal RPO/RTO; or
- authenticated workflow monitoring and data/schema evidence.

An institution-approved recipient and delivery test remain required before a
failed workflow can be treated as an acknowledged operational alert. The
GitHub scheduling is not institutionally guaranteed monitoring, and the
existing M6 monitoring contract remains the authority for alert-delivery and
operational decisions.
