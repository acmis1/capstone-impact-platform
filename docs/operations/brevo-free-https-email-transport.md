# Brevo Free HTTPS Email Transport Runbook

## 1. Overview and Architecture

This runbook describes the temporary, team-controlled free HTTPS transactional email transport for the Capstone Impact Platform Admin/CMS application (`apps/admin-cms`).

### Why HTTPS Transport?
- **Render Free Port Blocking**: Render Free web services block outbound traffic on SMTP ports (`25`, `465`, `587`). Using standard HTTPS (`POST https://api.brevo.com/v3/smtp/email` on port `443`) allows reliable outbound email delivery on Render Free without requiring a paid subscription or full application rehosting.
- **Provider-Neutral Interface**: Orchestration interacts exclusively with `ParticipantPreviewEmailTransport` and the PostgreSQL durable ledger. Existing SMTP and Local email sink integrations remain 100% functional and compatible for future institutional RMIT provider handoff and local regression testing.

---

## 2. Free Tier Bounds and Cost Governance

- **Plan**: Brevo Free plan.
- **Cost**: \$0 / completely free (no credit card required, no expiring trial period).
- **Daily Volume**: 300 emails per calendar day.
- **Quota Queuing Behavior**: Brevo documentation states that after the daily limit is reached, up to 1,000 transactional emails may be held in a provider retry queue. Therefore, provider acceptance (`outcome: 'accepted'`) does **not** prove timely inbox arrival or deadline delivery. Daily quota exhaustion does not necessarily return an immediate HTTP 429.
- **Email Branding**: Outbound emails on the Brevo Free plan include Brevo branding. This is an expected provider condition for the temporary free transport.
- **No Paid Upgrades**: No paid plan or subscription tier is authorized or recommended as the project solution.
- **Quota Accounting**: The 300 sends/day volume is shared across initial participant preview dispatches and subsequent reminder emails.
- **Load Testing Policy**: Bulk/load testing (e.g. 300+ project cohorts) must use the local SMTP capture sink (`LOCAL_SMTP`), never the live Brevo quota.

---

## 3. Account, Sender, and Privacy Prerequisites

The autonomous coding agent cannot and must not create external accounts or log into private dashboards. Operators must perform these setup steps before live verification:

1. **Create Free Account**:
   - Register a free account at [brevo.com](https://www.brevo.com).
2. **Generate API Key**:
   - Navigate to **Settings > SMTP & API > API Keys**.
   - Generate a new v3 API key (starts with `xkeysib-...`).
   - Store securely in password manager / environment configuration. Never commit or log this key.
3. **Register Sender Email**:
   - Navigate to **Senders & IP > Senders**.
   - Add a verified sender address (e.g., team-managed address or testing mailbox).
   - Click the verification link sent by Brevo to activate the sender.
   - *Note on Free Email Domains*: Free public domains (such as `@gmail.com` or `@yahoo.com`) cannot have DKIM/SPF authenticated by the team. Brevo may temporarily rewrite the sender to a provider-owned address (e.g. `@brevo.com` or `@mailin.fr`) to prevent upstream rejection by DMARC policies.
4. **Mandatory Privacy and Retention Controls**:
   - *Third-Party Processing*: Brevo necessarily processes recipient addresses and email body content to perform delivery. Absolute provider secrecy cannot be claimed.
   - *Observed Tracking UI*: The current test account exposed **Anonymous email tracking?**, initially set to **No**, rather than separate Open Tracking and Click Tracking on/off controls. Brevo documents **Yes** as anonymizing open/click engagement tracking. Anonymized tracking is still tracking and must not be described as tracking disabled.
   - *Per-Contact Tracking Consent*: The application passes `contactPixelTrackingConsent: false` in every API payload. This value is not proof that click tracking is disabled or that a capability-bearing link will be preserved byte-for-byte.
   - *Required Dashboard Configuration*: Before any REAL capability-bearing preview email is enabled:
     1. Verify in Brevo dashboard settings that transactional email previews are configured as **Never store previews**.
     2. Configure transactional log retention to the minimum duration permitted by the plan.
     3. Where the current UI exposes **Anonymous email tracking?**, set it to **Yes** before the live canary and record that this anonymizes engagement tracking. Do not claim that tracking is fully disabled unless the actual provider configuration proves it.
     4. If a future Brevo UI exposes true open/click disable controls, disable them as an additional privacy control.
     5. Independently conduct the synthetic canary test below. Exact link preservation is mandatory because neither anonymous tracking nor `contactPixelTrackingConsent: false` proves that Brevo will preserve a click URL.

---

### Recorded TEST qualification result — 2026-09-15

The team-controlled Free account completed the bounded provider qualification sequence. Transactional previews are set to **Never store previews**, log retention is **1 month** (the shortest available), and **Anonymous email tracking? = Yes** is recorded as anonymization rather than tracking disablement. The verified test sender and API key remain outside repository evidence.

The patched verifier returned `SANDBOX_NO_DELIVERY` against Brevo sandbox/drop mode. Exactly one subsequently authorised live synthetic canary was accepted and received by the team-controlled test mailbox. Its expected `https://example.com/pp1-brevo-canary/<runId>` anchor was **rewritten through Brevo tracking infrastructure** rather than preserved byte-for-byte.

Therefore Brevo is **provider-connectivity verified but not qualified for participant capability-bearing preview links** under this runbook. Keep `PARTICIPANT_PREVIEW_EMAIL_ENABLED` disabled for that workflow and retain the manual token/copy fallback until an institutional provider or provider configuration demonstrably preserves the exact capability URL. Do not send another qualification canary merely to repeat this result.

---

## 4. Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `PARTICIPANT_PREVIEW_EMAIL_ENABLED` | Yes | `false` | Must be explicitly `'true'` to enable delivery. |
| `PARTICIPANT_PREVIEW_EMAIL_PROVIDER` | No | `'smtp'` | Set to `'brevo'` to activate HTTPS transport. |
| `PARTICIPANT_PREVIEW_EMAIL_BREVO_API_KEY` | If Brevo | None | Brevo v3 API Key (`xkeysib-...`). |
| `PARTICIPANT_PREVIEW_EMAIL_FROM` | Yes | None | Authoritative, verified sender email address. |
| `PARTICIPANT_PREVIEW_EMAIL_FROM_NAME` | No | None | Display name (e.g. `"Capstone Impact Platform"`). |
| `PARTICIPANT_PREVIEW_EMAIL_BREVO_SANDBOX` | No | `false` | Set to `'true'` to enable Brevo sandbox mode. |

### Fail-Closed Behavior
If `PARTICIPANT_PREVIEW_EMAIL_ENABLED` is `'true'` but `PARTICIPANT_PREVIEW_EMAIL_BREVO_API_KEY` or `PARTICIPANT_PREVIEW_EMAIL_FROM` is missing or invalid, the configuration resolver treats delivery as **disabled** (`{ enabled: false }`). The system never "tries anyway" with partial or ambiguous configuration.

---

## 5. Delivery State Machine and Ledger Invariants

The transport respects the application's strict three-outcome contract:

1. **`accepted`**:
   - Provider returned HTTP `201` Created carrying a valid, non-empty, bounded provider `messageId`.
   - Durably recorded as `sent` with provider transport reference.
   - **Important**: `accepted` proves provider queuing, **not** inbox placement or human receipt.
2. **`rejected`**:
   - Definite permanent failure reliably reported by provider:
     - HTTP `401` / `403`: `TRANSPORT_UNAVAILABLE` (invalid key or IP block).
     - HTTP `404`: `TRANSPORT_UNAVAILABLE` (misconfigured endpoint).
     - HTTP `429`: `MESSAGE_REJECTED` (rate limit or immediate quota refusal; no blind retries).
     - HTTP `400` (structured recipient parameter refusal): `RECIPIENT_REJECTED`.
     - HTTP `400` (other payload/request refusal): `MESSAGE_REJECTED`.
   - Durably recorded in the ledger as `failed` with failure code.
3. **`unknown`**:
   - Ambiguous outcome where post-transmission status cannot be verified:
     - Socket timeout, DNS error, or dropped connection after dispatch.
     - HTTP `200` OK (unsupported for single-send).
     - Empty, unreadable, or malformed JSON HTTP `201` response.
     - HTTP `201` response missing a valid provider `messageId`.
     - Oversized provider response (>64 KiB).
     - Fetch redirect refusal (`redirect: 'error'`).
     - HTTP `500`, `502`, `503`, `504` server errors.
   - Durably recorded as `delivery_unknown`.
   - **Crucial Rule**: `delivery_unknown` is **never** retried automatically. Retrying an unknown send could cause duplicate emails to participants.

### Idempotency Key Handling
- The transport computes a deterministic UUIDv4 idempotency key derived from the message's unique `Message-ID` and passes it inside the JSON request-body `headers` map (`headers: { 'Idempotency-Key': ... }`).
- Standard email headers (such as `Message-ID`) are kept strictly absent from Brevo's request-body headers.
- In sandbox mode, `X-Sib-Sandbox: 'drop'` is likewise passed inside the request-body `headers` map.
- Idempotency is strictly a secondary defense; the application's atomic PostgreSQL ledger lease remains the primary execution fence.

---

## 6. Operator Verification Playbook

A dedicated runtime script is provided for operators to qualify the integration safely without risking unexpected automated sends:

```bash
# Location
apps/admin-cms/src/scripts/verifyBrevoEmailTransportRuntime.ts
```

### Safety Protections:
- Blocked in CI environments (`CI=true` or `GITHUB_ACTIONS=true`).
- Requires explicit command-line opt-in flag `--opt-in-real-send` for live sends.
- Rejects broad domain wildcards (e.g. `@rmit.edu.vn`). Live sending requires an **exact explicit mailbox allowlist** (`BREVO_VERIFICATION_ALLOWLIST`). A typo to an unapproved address will fail closed.
- Output privacy: Does NOT print recipient email addresses, preview bearer URLs, API keys, or raw provider message IDs in console or status outputs. Returns bounded status, a one-way `referenceFingerprint`, and `details.expectedCanaryUrl`. The expected URL is safe to expose because it contains only a public reserved host and the synthetic verifier run ID.
- Strictly limits send volume to 1 message per execution.

### Step 1: Sandbox Validation (Zero Delivery)
Verify credentials and API reachability with Brevo's provider-side drop behavior, without delivering mail:
```bash
PARTICIPANT_PREVIEW_EMAIL_ENABLED=true \
PARTICIPANT_PREVIEW_EMAIL_PROVIDER=brevo \
PARTICIPANT_PREVIEW_EMAIL_BREVO_API_KEY="xkeysib-..." \
PARTICIPANT_PREVIEW_EMAIL_FROM="verified-sender@example.com" \
PARTICIPANT_PREVIEW_EMAIL_BREVO_SANDBOX=true \
npx tsx apps/admin-cms/src/scripts/verifyBrevoEmailTransportRuntime.ts --opt-in-real-send --recipient tester@example.test
```
Expected output:
```json
{
  "outcome": "SANDBOX_NO_DELIVERY",
  "message": "Brevo sandbox accepted the request; delivery dropped at provider per sandbox configuration.",
  "referenceFingerprint": "...",
  "details": {
    "deliveryEffect": "SANDBOX_DROPPED_NO_DELIVERY",
    "expectedCanaryUrl": "https://example.com/pp1-brevo-canary/0123456789ab"
  }
}
```

The 12-character hexadecimal suffix is generated for each verifier run. The same exact URL appears once in the text content and as the HTML anchor `href`. Sandbox still returns `SANDBOX_NO_DELIVERY`: including the URL in dropped content does not create a live send, prove inbox delivery, or prove that Brevo preserves links in delivered mail.

### Step 2: Single Live Send to Team-Owned Mailbox
After sandbox succeeds and the privacy controls above are recorded, manually run at most one live canary to the exact team-owned mailbox allowlist. The verifier makes one send attempt per invocation and must not be placed in an automated retry loop:
```bash
PARTICIPANT_PREVIEW_EMAIL_ENABLED=true \
PARTICIPANT_PREVIEW_EMAIL_PROVIDER=brevo \
PARTICIPANT_PREVIEW_EMAIL_BREVO_API_KEY="xkeysib-..." \
PARTICIPANT_PREVIEW_EMAIL_FROM="verified-sender@example.com" \
BREVO_VERIFICATION_ALLOWLIST="team-testing-mailbox@rmit.edu.vn" \
npx tsx apps/admin-cms/src/scripts/verifyBrevoEmailTransportRuntime.ts --opt-in-real-send --recipient team-testing-mailbox@rmit.edu.vn
```
Expected output:
```json
{
  "outcome": "ACCEPTED",
  "message": "Brevo transactional HTTPS transport accepted the message for delivery.",
  "referenceFingerprint": "...",
  "details": {
    "deliveryEffect": "ACCEPTED_FOR_TRANSMISSION",
    "expectedCanaryUrl": "https://example.com/pp1-brevo-canary/0123456789ab"
  }
}
```

`ACCEPTED` proves only that Brevo accepted the HTTPS request. It does not prove inbox receipt or exact URL preservation.

### Step 3: URL-Rewrite Qualification Decision

Participant capability email is provider-qualified only when all of these conditions pass:

1. The verifier result is `ACCEPTED`.
2. The test mailbox receives the one synthetic message.
3. The received HTML anchor's `href` is byte-for-byte identical to `details.expectedCanaryUrl`.
4. No Brevo redirect or tracking domain replaces that `href`.

If Brevo accepts the message but rewrites the synthetic link, the provider is **not qualified for participant capability email** under the current privacy contract. Keep participant email disabled, retain the manual token/copy workflow, and document Brevo as provider-accepted but unsuitable for capability-bearing preview links. Wait for an institutional provider or a provider configuration that demonstrably preserves the exact URL. Free-provider acceptance is not grounds to weaken this requirement.

### Step 4: End-to-End Workflow Verification

Only after Step 3 passes:

1. Record the canary evidence showing that the received URL is intact and un-rewritten.
2. Log into Admin CMS as an authorized staff member (`projects.review` permission).
3. Open a test project in staging.
4. Trigger **Generate Participant Preview** with email delivery enabled.
5. Confirm ledger records status `sent` with transport reference.
6. In the recipient mailbox, confirm the email is received and links point to the canonical public URL.
7. Open the preview link, test synthetic participant confirmation, and verify status converges to `confirmed`.

---

## 7. Troubleshooting and Failure Runbook

| Symptom | Probable Cause | Action |
|---|---|---|
| `outcome: 'rejected'`, `failureCode: 'TRANSPORT_UNAVAILABLE'` | Invalid API key, expired key, or Brevo account suspended. | Verify key in Brevo dashboard under SMTP & API. Ensure IP access restrictions allow Render host. |
| `outcome: 'rejected'`, `failureCode: 'RECIPIENT_REJECTED'` | Brevo rejected recipient email format or domain. | Check recipient format; ensure recipient is not on Brevo's blocked contacts list. |
| `outcome: 'rejected'`, `failureCode: 'MESSAGE_REJECTED'` | Provider refused message (e.g. immediate quota refusal, duplicate request, or unverified sender). | Check Brevo dashboard quota counter and sender status. Defer batch until quota resets. |
| `outcome: 'unknown'` | Network timeout, dropped socket, unparseable 201 response, or transient Brevo 5xx outage. | Do NOT manually trigger immediate bulk resend. Ledger protects against duplicate dispatches. Inspect Brevo status page. |
