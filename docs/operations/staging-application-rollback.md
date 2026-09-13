# Staging Admin/CMS Application Rollback and Redeployment

This is the machine-side gate for the Admin/CMS staging web application. The command does not
deploy, mutate Supabase, downgrade/repair/restore a database, change Storage, call Duda or
publication endpoints, or send email. The deployment remains a supervised action by an authorized
Render operator. No Render Blueprint is required.

## Safety contract

- `rollback` selects a different previously verified commit; `redeploy` selects the exact currently
  deployed commit. Both are application-only operations.
- The target must be a full 40-character commit that exists locally and is contained by the
  selected `origin/*` reviewed ref. The tracked checkout must be clean.
- The plan binds the commit, source tree, Admin/CMS tree, lockfile object, migration tree, and
  database-contract object into one SHA-256 source-artifact identity.
- Review, CI, prior deployment/smoke, change, and provider credential-access evidence references
  are required. References are non-secret labels; never put credentials, URLs, emails, or user
  identities in them.
- Migration count and head come from the repository manifest. The target application, current
  repository, and hosted database must have the exact same migration tree/versions and capability
  contract. No migration number is duplicated here.
- A mismatch returns `APPLICATION_ROLLBACK_REFUSED_DATABASE_FORWARD_RECOVERY_REQUIRED`. Keep staff
  mutation access blocked and forward-recover the application for the database's current
  append-only contract. Never downgrade, delete, repair, or restore hosted data in place.
- File-only Gate 4 evidence can produce bounded local dry-run evidence, but a checksum authenticates
  bytes, not hosted origin. It can never authorize a provider action. Authorizable and successful
  post-deploy checks collect Gate 4 evidence directly from the exact linked staging project under a
  read-only transaction guard and compare it with a repository-migrated disposable Local database
  in the same process.

## Local evidence-only dry run

With a clean reviewed checkout and a disposable Local Supabase stack at the current repository
manifest, compare an existing Gate 4 file using the established checker:

```bash
npm run check:gate4-schema-evidence -- --evidence-file=<gate4-evidence.json> --expected-git-sha=<tooling-sha> --machine-readable
```

The result includes the SHA-256 of the exact input evidence bytes. Run the local-only preflight:

```bash
npm run check:admin-staging-rollback -- local-preflight --intent=rollback --target-commit=<last-known-good-full-sha> --current-deployed-commit=<currently-deployed-full-sha> --reviewed-ref=origin/main --gate4-evidence=<gate4-evidence.json> --gate4-attestation=<gate4-attestation.json> --observed-at=<actual-UTC-observation-time> --change-reference=<change-ref> --review-approval-reference=<review-ref> --ci-reference=<ci-ref> --prior-deployment-reference=<deployment-ref> --prior-smoke-reference=<smoke-ref> --deployment-credential-reference=<credential-check-ref> --json
```

An exact local match exits `2` as
`LOCAL_EVIDENCE_MATCH_DATABASE_AUTHORITY_NOT_PROVEN`. `--authorize` is refused. This is local
evidence, never hosted compatibility or completed rollback evidence.

## Authoritative preflight and authorization

The supervised operator configures the staging runtime identity, repository-pinned Supabase CLI
access token, and exact linked staging project described in
[Admin/CMS Hosted Staging Deployment](../admin-cms-hosted-deployment.md). The current repository
manifest must also be running in the disposable Local stack. No credential is printed or persisted.

Run the same arguments with `preflight`, add `--base-url=<exact-staging-base-url>`, and omit
`--gate4-evidence`, `--gate4-attestation`, and `--observed-at`. Before database inspection, the
command runs the existing credential-free GET/HEAD hosted smoke and requires the actually observed
deployed full SHA to equal `--current-deployed-commit`. It then performs the direct read-only hosted
Gate 4 query and exact Local comparison. The tooling checkout's current HEAD must also exactly equal
the selected reviewed-ref commit. It exits `2` as `DRY_RUN_READY_AUTHORIZATION_REQUIRED` only when
all gates pass.

Only the deployment authority may repeat that command with:

```text
--authorize --confirmation=<CAPSTONE_STAGING_MUTATION_CONFIRMATION>:<rollback-or-redeploy>:<full-target-sha>
```

The direct database check runs again. Only `AUTHORIZED_FOR_MANUAL_PROVIDER_ACTION` exits `0`.
Save its JSON outside the repository. It is a permission plan, not deployment evidence, and still
performs no hosted mutation.

The authorized Render operator then uses the existing staging service's official exact-commit
rollback/redeploy control and records the deployment reference. Do not change auto-deploy,
root/commands, health path, environment values, secrets, DNS, Supabase, Storage, Duda, or
publication state.

## Post-deploy verification

Record an interrupted action without contacting application or database endpoints:

```bash
npm run check:admin-staging-rollback -- post-deploy --plan=<authorized-plan.json> --deployment-state=interrupted --deployment-reference=<deployment-ref> --json
```

For a provider-reported successful deployment, run:

```bash
npm run check:admin-staging-rollback -- post-deploy --plan=<authorized-plan.json> --deployment-state=succeeded --deployment-reference=<deployment-ref> --base-url=https://admin-cms-staging.example --json
```

This verifies plan integrity, repeats direct read-only hosted Gate 4 comparison, and runs the
existing credential-free GET/HEAD smoke against the exact target SHA. An exact technical match is
reported as `POST_DEPLOY_TECHNICALLY_VERIFIED_AUTHORIZATION_NOT_PROVEN` with exit `2`: an imported
or self-hashed plan cannot prove that the earlier authorization was genuinely witnessed. The
supervising operator/reviewer must correlate this technical result with the live authorization
record before release acceptance can continue. Complete supervised workflow/UAT, monitoring
recovery, the release checklist, and incident/change closure before restoring access.

## Abort and recovery

| Failure | Required action |
| :--- | :--- |
| Invalid/unreachable commit, dirty checkout, or commit outside reviewed ref | Stop; obtain the exact reviewed commit and clean evidence checkout. |
| Missing staging config, direct-read credential, provider credential evidence, review, CI, or prior smoke | Stop; the responsible owner supplies fresh evidence. Never bypass with a mutable artifact. |
| File-only, stale, tampered, wrong-target, drifted, or unavailable database evidence | Stop or retain only the explicit `NOT_PROVEN` local result; run the direct supervised check. |
| Target/current/database migration tree or capability contract mismatch | Refuse rollback, keep access blocked, and forward-recover an application for the current database contract. |
| Provider action fails before changing the active deployment | Preserve current deployment/evidence; retry only with a new fresh authorized plan. |
| Provider action is interrupted or terminal state is unknown | Treat as `DEPLOYMENT_INTERRUPTED`; keep access blocked. Resume the exact target or separately authorize the recorded prior commit. |
| Post-deploy commit, readiness, migration expectation, or Gate 4 mismatch | Treat as Severity 1. Keep access blocked; use the prior commit only if fresh compatibility still matches, otherwise forward-recover. |
| Data/Storage loss, credential/config loss, DNS/TLS fault, or publication/Duda drift | Application rollback is insufficient. Invoke that boundary's separately authorized recovery plan. |

No successful hosted drill is claimed here. Historical rehearsal is point-in-time evidence; every
future action needs a fresh plan and evidence set.
