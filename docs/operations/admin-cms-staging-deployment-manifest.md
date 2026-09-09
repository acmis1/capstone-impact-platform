# Admin/CMS Staging Deployment Manifest

This is the narrow handoff contract for the existing Admin/CMS staging web service. The tracked
machine-readable source is [`admin-cms-staging.manifest.yaml`](../../infra/deployment/admin-cms-staging.manifest.yaml).
It is a provider-neutral reconciliation manifest with Render facts recorded explicitly; it is not
`render.yaml`, a deployment trigger, or permission to change a provider dashboard.

## What is reproducible

An incoming owner can reconstruct the repository-facing service settings without guessing:

- Render web service, service identity `capstone-admin-cms-staging-v2`, Singapore region
  (`ap-southeast-1`), the current `main` source branch, Free plan, and auto-deploy **off**;
- repository root as the service root (`.`);
- Node `24.14.1` with npm `11.11.0`;
- build `npm ci && npm run build:admin`;
- start `npm run start --workspace=apps/admin-cms`;
- health check `/api/readiness`, whose successful contract is HTTP 200 and whose route supports
  both `GET` and `HEAD`;
- staging identity `CAPSTONE_RUNTIME_ENV=staging` and fail-closed publication/staff/email/assistive
  feature defaults.

Run the deterministic local verifier from the repository root:

```text
npm run check:deployment-manifest
```

The verifier compares the manifest with the root and Admin/CMS package scripts, `.nvmrc`, engine
constraints, and the readiness route. It rejects paid plans, auto-deploy enabled, a non-root service
directory, a non-Node runtime, a wrong health path, publication enabled by default, owner-supplied
secret/config values, and missing required environment names. It makes no network calls.

## Manual import and reconciliation

1. Review the manifest and run the verifier at the reviewed commit. Do not rename it to
   `render.yaml` or use it as an automatic import file.
2. In the institution-owned Render account, select the existing staging web service or create a
   separately reviewed equivalent. Reconcile each `service` field manually, including auto-deploy
   remaining off. Preserve the existing staging service identity and keep the legacy Prototype
   service separate.
3. Add the owner-supplied environment names to the provider secret/config store. Use the active
   staging Supabase URL and matching host, the publishable client key, the server-only Supabase
   secret key, and a separately generated `CAPSTONE_AUTH_FLOW_SECRET`. The manifest contains no
   values for these fields and invents no URL, credential, or secret.
4. Leave the fail-closed flags at `false` unless a separately authorized staging operation requires
   a temporary change. Never enable a production/live Duda publication gate through this service.
5. Save/reconcile the provider settings manually, then run the verifier again from the same
   repository commit. A provider owner may perform a later read-only hosted smoke check with an
   explicitly supplied base URL; that check is outside this manifest and is not run here.

## What remains manual or institutional

The manifest cannot prove or perform provider-account ownership, Render dashboard state, secret
values, Supabase migration/schema/RLS/Auth/Storage state, backups, monitoring, human UAT, or an
institutional release decision. It also does not deploy, publish, contact Render/Supabase/Duda, or
change the live Duda showcase. Production/live Duda remains a separate controlled environment and
cutover decision.
