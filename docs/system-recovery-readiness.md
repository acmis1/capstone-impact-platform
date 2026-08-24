# System Recovery Readiness Runbook

This runbook covers repository/disposable-Local recovery evidence for the active Admin/CMS. It does not authorize or perform hosted Supabase, Render, Duda, email, public-feed history, or public-feed rollback operations.

## Current evidence boundary

The repository provides a non-destructive Local recovery drill at:

```text
apps/admin-cms/src/scripts/verifyLocalRecoveryReadiness.ts
```

The drill proves that the pinned Local toolchain can:

1. create a randomly named verifier-owned PostgreSQL schema with synthetic evidence;
2. produce an in-memory custom-format `pg_dump` backup;
3. remove only that verifier-owned schema to simulate loss;
4. restore it with `pg_restore` and verify the exact row and SHA-256 evidence;
5. create a randomly named verifier-owned private Storage bucket with synthetic objects;
6. discover and download the objects into an in-memory backup manifest;
7. remove only that verifier-owned bucket to simulate loss;
8. recreate it, restore every object, and verify the exact object set, byte length, and SHA-256 checksums; and
9. attempt cleanup on every outcome, verify that all verifier-owned residue is absent, and fail with a dedicated cleanup code if it is not.

The drill reads the three canonical Local bucket configurations but never uploads, overwrites, removes, or restores their objects. Schema and bucket cleanup is authorized only after the current execution successfully creates that exact probe resource; a matching name alone never grants deletion authority. It never resets the Local database. Backup bytes remain in memory and are not written into the repository or an operator-selected path.

## Safety preconditions

- Use the repository-pinned Node, npm, Supabase CLI, and Docker toolchain.
- Use synthetic Local data only.
- The verifier must observe the exact repository Local stack as `RUNNING`.
- The Supabase API URL must be loopback (`127.0.0.1`, `localhost`, or `::1`).
- A missing, stopped, degraded, unknown, or non-loopback target is refused before probe mutation.
- Do not run `supabase db reset`, `supabase db push`, `supabase migration repair`, or hosted dashboard recovery actions as part of this drill.

## Preserve the pre-task Local state

Determine and record one state before starting:

```bash
npm run supabase:assert-running
npm run supabase:assert-stopped
```

Interpret the results as follows:

| Observation | Recorded state | Action |
| :--- | :--- | :--- |
| `supabase:assert-running` passes | `RUNNING` | Reuse the stack. Do not reset it. Leave it running after the drill. |
| `supabase:assert-stopped` passes | `STOPPED` | Start with `npm run setup:local`. Stop it after all checks. |
| Neither passes | `DEGRADED` | Stop. Resolve the Local stack condition before running recovery verification. |

## Execute the Local recovery drill

If the recorded state was `STOPPED`, start the repository Local stack:

```bash
npm run setup:local
```

Run the recovery verifier directly through the existing workspace `tsx` dependency:

```bash
npm exec --workspace=apps/admin-cms -- tsx src/scripts/verifyLocalRecoveryReadiness.ts
```

Required evidence:

```text
LOCAL_RECOVERY_CLASSIFICATION = VERIFIED
DATABASE_BACKUP_RESTORE = PASS (1 synthetic row)
STORAGE_BACKUP_RESTORE = PASS (2 synthetic objects)
CANONICAL_APPLICATION_TABLES_OR_STORAGE_OBJECTS_MUTATED = NO
RECOVERY_PROBE_RESIDUE = NONE
HOSTED_SYSTEMS_CONTACTED = NO
```

The database backup byte count varies and is evidence only; it must be greater than zero. Any other classification is a failed drill. Do not retry blindly if cleanup reports failure—inspect the exact Local stack before further action.

## Post-recovery smoke checks

After the recovery verifier passes, run the existing integrity and application smoke checks:

```bash
npm run supabase:verify:local
npm run check:app-smoke
```

Required results:

- Local schema, grants, RLS, Auth, canonical Storage buckets, fixtures, and synthetic sign-in checks pass.
- `/api/health` returns HTTP 200.
- `/login` returns HTTP 200 and contains the stable Admin/CMS marker.

These smoke checks verify that the ordinary Local application remains usable after the isolated drill. The current `/api/health` route is a liveness/configuration-classification endpoint; it does not prove database query readiness or external monitoring activation.

## Restore the pre-task Local state

- If the recorded state was `RUNNING`, leave the stack running.
- If the recorded state was `STOPPED`, run:

  ```bash
  npm run supabase:stop
  npm run supabase:assert-stopped
  ```

- If cleanup or state restoration fails, report `LOCAL_ENVIRONMENT_NOT_RESTORED` and stop.

## What this drill does not prove

This bounded verifier is recovery-mechanics evidence, not a production backup system. The following remain required before operational acceptance:

- an institutionally approved hosted database backup cadence, retention period, encryption/access policy, and restore target;
- hosted database restore rehearsal and recovery-point/recovery-time measurements;
- complete export and restore of the three canonical Storage buckets and their object metadata;
- provider configuration, environment-variable, DNS, and secret inventory recovery from an institution-owned secret manager;
- Render deployment/redeployment and rollback rehearsal;
- external uptime monitoring, alert routing, escalation ownership, and retained health evidence;
- a real hosted post-restore application smoke test; and
- named institutional owners with credentials and incident-response authority.

All hosted actions above require separate operator authorization and credentials. Public-feed history and rollback remain a separate teammate-owned feature and are not part of system/database/Storage disaster recovery.
