# Zero-Cost Hosted-Origin Recovery Rehearsal

PP1 has a hard zero-paid-services constraint. This procedure uses a read-only logical export from
the approved Supabase Free staging project, an operator-controlled private bundle, and a fresh
disposable Local/self-hosted Supabase target. It requires no Supabase Pro plan, branch, PITR,
managed backup, extra hosted project, paid compute, or paid backup storage.

This procedure proves portable hosted-origin recovery mechanics. It does **not** prove Supabase
managed PITR, a managed hosted restore, production recovery, a hosted SLA, or a hosted RTO. The
reported durations are isolated Local/self-hosted recovery timings.

## Non-negotiable boundaries

- The only approved hosted source ref is `sqkpceeltukbzxpsvinb`.
- Historical staging `fewcbklmbgzglfgedtvt`, Prototype `bpnmrgmzgbisvykppuwp`, missing refs, and
  every other ref are refused before capture.
- The capture command checks both the operator-supplied ref and the Supabase CLI's existing linked
  project metadata. It never links or relinks a project.
- Capture exposes only logical dump and read-only evidence operations. It does not expose push,
  reset, repair, migration application, hosted SQL mutation, Auth mutation, or Storage mutation.
- Restore always owns a random disposable project, marked temporary workdir, labelled network,
  containers, and volumes. It never targets or resets the canonical PP1 Local stack.
- No recovery command publishes, contacts Duda, sends email, signs in as a copied user, or restores
  over active staging.

The real hosted capture remains a separately authorized operator action. Coding and CI agents run
only the synthetic Local rehearsal.

## Private bundle contract

The operator must choose an absolute, empty directory outside the repository and every Git
worktree. Symlinked destinations, tracked paths, non-empty paths, and paths inside another Git
checkout are refused. A successful real bundle is retained until the operator applies the approved
retention procedure; the recovery tooling never deletes it automatically.

The bundle contains private database rows, Auth state, object keys, and object bytes. Never put it
in Git, a GitHub issue, Actions artifact, release, CI cache, shared log, or public object store.
Restrict filesystem access and move it only through an institution-approved private channel.

The safe manifest binds:

- format and evidence versions, exact source ref/environment, reviewed Git SHA, timestamps, Node,
  Supabase CLI and PostgreSQL evidence;
- the exact repository migration manifest and latest migration;
- byte length and SHA-256 for each database artifact;
- the three canonical bucket identities, visibility, file-size/MIME policy, object counts, byte
  totals, and checksum roots;
- checksummed references to the private object manifest, non-content table evidence, and source
  Gate 4 evidence; and
- Auth counts plus the authoritative assistive execution-control cost fence.

Restore verifies every consumed checksum before starting a disposable target. Missing, changed,
duplicated, path-traversing, oversized, or structurally invalid material fails closed.

## Database and Storage split

The logical database artifacts are replayed in this order:

```text
roles.sql
schema.sql
migrations-schema.sql
data.sql
migrations-data.sql
```

`data.sql` excludes provider-managed `storage.*` table data. Storage objects and bucket
configuration are captured and restored separately through the supported Storage API. Never insert
or update `storage.objects` directly: provider-managed metadata is not a portable SQL restore
boundary, and direct writes would not prove that object bytes are readable through Storage.

The private Storage manifest records each object's canonical bucket, exact key, byte length,
SHA-256, content type, last-modified evidence, and provider version/eTag when available. Normal
summaries print only canonical bucket names, counts, byte totals, and checksum-root prefixes; they
do not print object keys.

The logical dump preserves supported Auth database state. Verification reports only source and
restored user/identity counts plus orphan-identity integrity; it never prints UUIDs, emails,
password hashes, identity payloads, or performs a copied-user login.

## Phase A — separately authorized read-only capture

Use an already reviewed checkout of the exact release commit and an already linked Supabase
workdir whose `supabase/.temp/project-ref` contains the approved ref. Do not run `supabase link` as
part of this procedure.

Place the required Storage read credential in `SUPABASE_SECRET_KEY` (or the legacy
`SUPABASE_SERVICE_ROLE_KEY`) through the approved operator secret channel. Do not paste its value
into the command, a file in the repository, or evidence output.

```bash
npm run capture:recovery-backup -- \
  --project-ref=sqkpceeltukbzxpsvinb \
  --output-dir=<absolute-empty-private-directory> \
  --supabase-workdir=<absolute-parent-containing-supabase-directory>
```

Required terminal evidence includes `SOURCE_CAPTURE_COMPLETE`, the exact reviewed SHA, 48
migrations ending at `20260831090000`, bounded database/Auth/execution-control counts, three bucket
summaries, `SOURCE_MUTATIONS = NONE`, and `PRIVATE_RECOVERY_EVIDENCE_NEVER_COMMIT`.

Stop if the target guard, migration history, source Gate 4 contract, Auth integrity, cost fence,
canonical bucket inventory, dump, checksum, or manifest validation fails. Do not repair or relink
the source from this workflow.

## Phase B — disposable restore and verification

Move to a machine that can run the repository-pinned Node, Supabase CLI, and Docker toolchain. Keep
the bundle outside every Git worktree, then run:

```bash
npm run restore:recovery-backup -- \
  --bundle-dir=<absolute-private-bundle-directory>
```

The verifier creates a fresh PostgreSQL 17 disposable target, replays schema and data with
`ON_ERROR_STOP`, restores Storage through the API, and checks:

- all 48 migrations and latest migration;
- 37 public application tables plus three execution-control tables;
- safe table row counts and order-independent checksums;
- Auth user/identity counts and zero orphan identities;
- launch guard `staging / 40 / 31 / 1`, reservation count/checksum, and executor registrations;
- all three bucket configurations and the exact object set, lengths, content types, and SHA-256;
- current Gate 4 structure: 40 tables, 78 application RPC signatures across 77 names, four
  dispatcher routines, and three buckets;
- `/api/health` 200, `/login` 200 with the stable marker, and a truthful non-staging readiness
  classification; and
- absence of verifier-owned containers, volumes, network, and workdir after cleanup.

Only `ZERO_COST_RECOVERY_REHEARSAL_VERIFIED` is success. Invalid/corrupt bundle, source capture,
database restore, database integrity, Storage, Gate 4, and cleanup failures remain distinct
classifications. A real bundle remains present on both success and failure.

## Synthetic full rehearsal

The repository-owned proof uses no hosted credential or provider call:

```bash
npm run verify:zero-cost-recovery-rehearsal
```

It creates a migrated PostgreSQL 15 source, seeds synthetic project/media/audit/participant
preview/public-feed/assistive/Auth/execution-control evidence plus one object in each canonical
bucket, captures a private synthetic bundle, restores it to PostgreSQL 17, runs all verification and
the application smoke, and cleans both stacks and the synthetic bundle.

The current cross-engine proof permits only a bounded PostgreSQL 15-to-17 Gate 4 normalization:
five known constraint-rendering differences and table-grant vocabulary/`GRANT ALL` effects involving
`MAINTAIN`, `REFERENCES`, `TRIGGER`, and `TRUNCATE`. Both source and target must independently pass
the current repository Gate 4 contract, and every other Gate 4 category must match. Real hosted
PostgreSQL 17-to-17 capture/restore requires exact Gate 4 equality.

## Timing language

Record only:

- `BACKUP_DURATION_MS`;
- `BACKUP_AGE_AT_RESTORE_START_MS`;
- `ZERO_COST_ISOLATED_RESTORE_DURATION_MS`; and
- `FULL_RECOVERY_VERIFICATION_DURATION_MS`.

Never relabel them as `HOSTED_RTO`, `PRODUCTION_RTO`, `MANAGED_RESTORE_RTO`, or provider RPO. A real
hosted-origin capture and independently reviewed isolated restore are still required before PP1 can
claim a supervised hosted-origin rehearsal.
