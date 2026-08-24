# Supabase Key Migration & Security Governance Runbook

## Overview & Key Architecture

Supabase key management has evolved from legacy JWT-based keys to named API key standards:

| Client Scope | Legacy Key | Modern Standard Key | Server-Only Access |
| :--- | :--- | :--- | :--- |
| **Browser Client** | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | No (Public) |
| **Server Admin** | `SUPABASE_SERVICE_ROLE_KEY` | `SUPABASE_SECRET_KEY` | **Yes (Strictly Private)** |

### Precedence & Compatibility Strategy

1. **Browser Client Keys**:
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` takes precedence over `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
   - Browser keys are restricted by Row Level Security (RLS) and Data API table grants.
2. **Server Admin Keys**:
   - `SUPABASE_SECRET_KEY` takes precedence over `SUPABASE_SERVICE_ROLE_KEY`.
   - Legacy `SUPABASE_SERVICE_ROLE_KEY` is maintained as a temporary backwards-compatibility fallback (`legacy_service_role_jwt_fallback`).
   - Server keys bypass Row Level Security and must **NEVER** be exposed to browser runtimes, client bundles, or public code.

---

## Security Governance & Handling Rules

1. **Zero Secret Exposure**:
   - Never commit API keys, service role keys, or secret keys to repository files.
   - Never share key values in GitHub issues, pull requests, Slack/Teams chats, screenshots, or documentation.
   - All secret keys must be injected strictly via environment variables or secret store managers at deployment time.
2. **One Named Secret Key per Environment/Operator**:
   - Staging and production environments must use separate, named secret keys.
   - Revocation of an individual operator or environment key must not impact other environments.
3. **Ownership and Offboarding**:
   - When a team member departs or changes roles, any individual credentials assigned to that member must be promptly revoked in the dashboard.

---

## Key Migration Workflow

When migrating a deployment from legacy service-role keys to modern secret keys, follow this systematic process:

### Step 1: Pre-Migration Inventory
Inspect environment variables across server hosting platforms (e.g. Render, Vercel) to confirm existing key configurations. Ensure both `SUPABASE_SECRET_KEY` and legacy fallback variables can be injected safely.

### Step 2: Deployment Change Order
1. Provision a modern named `SUPABASE_SECRET_KEY` in the Supabase Dashboard.
2. Configure `SUPABASE_SECRET_KEY` in the server deployment environment while keeping `SUPABASE_SERVICE_ROLE_KEY` as a fallback.
3. Redeploy the server application (`apps/admin-cms`).

### Step 3: Deployment Readiness Verification
Invoke the application readiness endpoint after the environment update:
```bash
curl -s https://<application-domain>/api/readiness
```
Confirm the response is HTTP 200 and reports only the bounded public contract:
```json
{
  "readiness": "ready",
  "classification": "READY",
  "configuration": "configured",
  "dependency": "reachable"
}
```
This proves that the server accepted a recognized administrative key type and completed the read-only dependency probe; it deliberately does not disclose which key variable or selection mode was used. Confirm the intended `SUPABASE_SECRET_KEY` configuration through the hosting platform's private environment controls. Verify that neither `/api/health` nor `/api/readiness` returns secret values, key lengths, key prefixes, or raw provider errors.

### Step 4: Fallback & Rollback Procedure
If issues are observed after injecting `SUPABASE_SECRET_KEY`:
1. Unset `SUPABASE_SECRET_KEY` in server environment settings.
2. The runtime automatically falls back to `SUPABASE_SERVICE_ROLE_KEY` in `legacy_service_role_jwt_fallback` mode.
3. Verify application stability before re-attempting migration.

### Step 5: Legacy Key Revocation
Only after the server has operated stably in `secret_key_preferred` mode for a required soak period across all services:
1. Confirm no legacy key references remain active in monitoring or logs.
2. Safely revoke the legacy service-role key in the dashboard settings.
