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

Capture writes a `PRIVATE_INCOMPLETE_RECOVERY_BUNDLE` marker before private bytes land and removes
it only after every artifact, source-stability check, checksum, and final manifest validation
passes. A failed capture can therefore leave private SQL or object bytes in an incomplete bundle.
Keep that directory outside Git and either retain it securely or destroy it manually under the
operator's approved evidence/retention policy. The tooling does not assume it is authorized to
delete potentially valuable recovery evidence.

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
  Gate 4 evidence;
- checksummed, structural-only evidence for the repository-owned customizations inside managed
  Auth/Storage schemas; and
- Auth counts plus the authoritative assistive execution-control cost fence.

Restore verifies every consumed checksum before starting a disposable target. Missing, changed,
duplicated, path-traversing, oversized, or structurally invalid material fails closed.

Managed Auth provider-version compatibility is derived from the checksum-bound `data.sql` COPY
headers, so the existing v2 bundle format remains valid and a previously captured bundle does not
need to be regenerated. The verifier does not execute bundle text to discover compatibility and
does not require new manifest metadata from `auth.schema_migrations`.

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

Before `roles.sql` is replayed, and only after every recorded artifact checksum has been
re-derived, the verifier structurally inspects the captured role dump for provider-global
`pg_parameter_acl` state. A hosted Supabase cluster carries platform-owned parameter ACLs;
`pg_dumpall --roles-only` reproduces them, and Local's intentionally non-superuser `postgres`
cannot replay one, so the whole schema phase aborts with SQLSTATE `42501` before `schema.sql` is
reached. The only reviewed provider-global difference is:

```sql
GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";
```

Supabase's own delta tooling classifies exactly these `log_min_messages` grants
(`supabase_admin` SET/ALTER SYSTEM, `supabase_realtime_admin` SET) as platform state and drops
them for non-superuser replay, so this is provider-managed cluster state that a fresh self-hosted
target does not carry and must not be made to carry. The compatibility action is therefore
normalization, never recreation: the verifier never replays the role dump as a superuser, never
grants `postgres` SUPERUSER, and never grants a parameter ACL or grant option.

Both the pinned CLI form above (`pg_dumpall --quote-all-identifier` quotes every identifier) and
the unquoted plain-`pg_dumpall` spelling of the same statement are accepted. Everything else fails
closed as `ROLE_PLATFORM_ACL_COMPATIBILITY_FAILED`: another parameter, another grantee, another
privilege, `ALTER SYSTEM`, `ALL`, `WITH GRANT OPTION`, any `REVOKE ... ON PARAMETER`, any
`SET SESSION AUTHORIZATION` grantor switch, duplicates, trailing SQL, and comment or token
variants. That classification is distinct from an ordinary `schema.sql` failure, and it stops the
run before a disposable target is even started.

Detection reads complete top-level statements, not physical lines. The role dump is first scanned
under a bounded PostgreSQL lexical model that understands ordinary strings, `E` escape strings with
backslash escaping, quoted identifiers, line comments, nested block comments, and both untagged and
tagged dollar-quoted strings, each of which may span lines in either an LF or a CRLF dump. A
semicolon inside any of them is role data, not a statement terminator, so a grant spelled inside a
role setting value or a comment stays ordinary role data and a real grant cannot be hidden inside
one. Both the parameter-ACL check and the grantor-switch check therefore see the same statement
however its tokens are spread across lines or separated by comments. Anything the model cannot
account for refuses rather than guesses: unterminated lexical state of any kind, and the one
construct whose containment would depend on `standard_conforming_strings` — an ordinary string
whose quote is preceded by an odd backslash run. The reviewed grant is normalized only when one
complete top-level statement is byte-identical to a canonical spelling and occupies a whole
physical line, which is also what lets normalization replace that statement and leave every other
byte, including the line terminator, exactly as captured.

When the reviewed grant is present, the verifier first checks the disposable target catalog: a
non-superuser `postgres`, a superuser `supabase_admin`, a `supabase_realtime_admin` that is
neither, and no existing `log_min_messages` parameter ACL. Any other target state fails closed, so
an unexpected target ACL is never overwritten. It then writes a temporary verifier-owned normalized
copy inside the disposable workdir, identical to the checksum-validated artifact except that the one
reviewed statement is replaced by a fixed comment, and replays that copy instead. The private
bundle, its manifest, its recorded checksums, and its SQL artifacts are never written; the normalized
copy is removed with the rest of the disposable target. Summaries report
`ROLE_PLATFORM_ACL_COMPATIBILITY = MATCH` or `NORMALIZED_KNOWN_PLATFORM_ACL` and never print
captured role text.

The logical dump preserves supported Auth database state. Verification reports only source and
restored user/identity counts plus orphan-identity integrity; it never prints UUIDs, emails,
password hashes, identity payloads, or performs a copied-user login.

After schema replay and before data replay, the verifier compares every Auth COPY table/column
requirement with the disposable target catalog. Unknown source-ahead tables or columns fail closed
as `MANAGED_AUTH_COMPATIBILITY_FAILED`. The only reviewed forward delta is Supabase Auth migration
`20260625000000_add_custom_claims_allowlist.up.sql`:

```sql
alter table auth.custom_oauth_providers
    add column if not exists custom_claims_allowlist text[] not null default '{}';
```

This fixed repository-owned statement runs only when that exact column alone is missing. An
existing column with a different type, nullability, or default is refused. The target catalog is
queried again after alignment and must report `text[] NOT NULL DEFAULT '{}'` before `data.sql` can
run. Bundle SQL never supplies executable compatibility DDL.

The standard Supabase schema dump intentionally excludes provider-managed schemas including
`auth` and `storage`. Supabase therefore requires custom triggers, policies, and other application
changes inside those schemas to be handled separately; see the official
[CLI dump reference](https://supabase.com/docs/reference/cli/supabase-db-dump) and
[backup/restore guidance](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore#schema-changes-to-auth-and-storage).
PP1 does not dump or replace either managed schema. Its complete current repository-owned boundary
is exactly:

- `auth.users.claim_staff_provisioning_auth_insert_before_insert` (`BEFORE INSERT`);
- `auth.users.claim_staff_provisioning_auth_insert_before_metadata_update`
  (`BEFORE UPDATE OF raw_user_meta_data`); and
- no custom Storage-schema objects (`0/0`).

Both Auth triggers execute `public.claim_staff_provisioning_auth_insert()`. Capture uses a bounded,
SELECT-only `pg_catalog` query to record the exact trigger timing/events/update columns, row mode,
enabled state, definition, and function identity without reading Auth identities. Restore first
validates that checksum-bound evidence against the fixed repository expectation, verifies the
public trigger function exists and returns `trigger`, and then runs only fixed reviewed repository
DDL. Catalog text from the bundle is never executed.

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
managed-schema customization contract, canonical bucket inventory, dump, source-stability check,
checksum, or manifest validation fails. Do not repair or relink the source from this workflow.

`data.sql` is produced by one `pg_dump --data-only` invocation and is internally consistent. The
capture also re-runs its database and managed-schema evidence at the end and fails
if the bounded source evidence changed during the capture. Supabase Storage exposes no matching
provider transactional snapshot in this zero-cost flow: conduct a real capture in a controlled,
quiescent window. Storage verification proves the exact object set and bytes that were captured;
it is not provider PITR and cannot claim cross-service point-in-time atomicity.

## Phase B — disposable restore and verification

Move to a machine that can run the repository-pinned Node, Supabase CLI, and Docker toolchain. Keep
the bundle outside every Git worktree, then run:

```bash
npm run restore:recovery-backup -- \
  --bundle-dir=<absolute-private-bundle-directory>
```

The verifier creates a fresh PostgreSQL 17 disposable target. Schema and data are separate
`ON_ERROR_STOP`/single-transaction phases; a data failure can leave the schema phase committed only
inside the verifier-owned disposable target. Any failure blocks VERIFIED, and mandatory cleanup
removes that partial target. Diagnostics distinguish `ROLE_PLATFORM_ACL_COMPATIBILITY_FAILED`,
`RESTORE_SCHEMA_FAILED`, `MANAGED_AUTH_COMPATIBILITY_FAILED`, and `RESTORE_DATA_FAILED`. It
then restores only approved PP1 managed-schema customizations, restores Storage through the API,
and checks:

- all 48 migrations and latest migration;
- 37 public application tables plus three execution-control tables;
- safe table row counts and order-independent checksums;
- Auth user/identity counts and zero orphan identities;
- exact source/repository/restored managed-schema evidence (`2/2` Auth, `0/0` Storage,
  `MANAGED_SCHEMA_CUSTOMIZATIONS = MATCH`);
- provider-global role compatibility (`ROLE_PLATFORM_ACL_COMPATIBILITY`);
- recovery-only table-grant compatibility (`TABLE_GRANT_PORTABILITY_COMPATIBILITY`);
- launch guard `staging / 40 / 31 / 1`, reservation count/checksum, and executor registrations;
- all three bucket configurations and the exact object set, lengths, content types, and SHA-256;
- current Gate 4 structure: 40 tables, 78 application RPC signatures across 77 names, four
  dispatcher routines, and three buckets;
- `/api/health` 200, `/login` 200 with the stable marker, and a truthful non-staging readiness
  classification; and
- absence of verifier-owned containers, volumes, network, and workdir after cleanup.

Only `ZERO_COST_RECOVERY_REHEARSAL_VERIFIED` is success. Both Gate 4 and the separate managed-schema
customization gate must pass: 48/48 migration history or `GATE4_MATCH` cannot compensate for a
missing Auth trigger. Invalid/corrupt bundle, source capture, database restore, managed-schema,
database integrity, Storage, Gate 4, and cleanup failures remain distinct classifications. A real
bundle remains present on both success and failure.

## Synthetic full rehearsal

The repository-owned proof uses no hosted credential or provider call:

```bash
npm run verify:zero-cost-recovery-rehearsal
```

It bind-preflights eight contiguous loopback TCP ports before each disposable stack, then creates
a migrated PostgreSQL 17 source and applies the exact reviewed source-ahead Auth column. It
seeds synthetic project/media/audit/participant
preview/public-feed/assistive/Auth/execution-control evidence plus one object in each canonical
bucket, asserts that the captured COPY header contains the new column, and makes the synthetic-only
target reproduce the pre-migration managed schema even when the locally cached Auth image is newer.
It then proves unaligned replay rejects the hosted-ahead COPY header, proves the normal schema dump
contains `0/2` PP1 Auth triggers, captures their separate structural evidence, aligns the one
reviewed provider delta, restores them to PostgreSQL 17, verifies exact structure and bounded synthetic
INSERT/UPDATE metadata-stripping behavior, runs all remaining verification and the application
smoke, and cleans both stacks and the synthetic bundle.

The same run also reproduces the hosted provider-global parameter ACL. Only a superuser can
`GRANT ... ON PARAMETER`, so a disposable local source cannot create that cluster-global state
naturally, and manufacturing it must never widen production privileged execution. The rehearsal
therefore rewrites the captured role artifact before the synthetic manifest and checksums exist, so
the finished bundle is checksum-valid and reaches the real production restore path. The fixture is
bound to the disposable stack itself, not to an option: capture accepts it only when it is handed
the running verifier-owned source identity, when the capture is reading exactly that stack's
workdir under the temporary root, when the workdir carries that stack's ownership marker, when the
recorded project identity is that stack's, and when the source database container is one the
Supabase CLI labelled with the same identity. An operator Local stack, a chosen project name, and a
chosen source kind satisfy none of that, and the check runs before the bundle directory, any dump,
or any checksum exists — so no real capture can reach the fixture. It then proves
that replaying the unnormalized captured role artifact into a fresh disposable PostgreSQL 17 target
genuinely fails with SQLSTATE `42501`
(`LEGACY_UNNORMALIZED_ROLE_REPLAY_FAILED = YES`), that the production planner selects only the
reviewed grant (`ROLE_PLATFORM_ACL_COMPATIBILITY = NORMALIZED_KNOWN_PLATFORM_ACL`), that the
normalized replay and both schema artifacts then succeed, and that the synthetic bundle's
`roles.sql` bytes and recorded checksum are byte-for-byte unchanged across the whole restore
(`SYNTHETIC_BUNDLE_ROLE_ARTIFACT_UNCHANGED = YES`).

After schema replay and before Auth/data replay, table-grant compatibility compares the validated,
checksum-bound source against the disposable target. It may revoke only target-only, non-grantable
`MAINTAIN`, `REFERENCES`, `TRIGGER`, or `TRUNCATE` privileges for `anon`, `authenticated`, or
`service_role` on the exact public application table inventory. It never grants privileges. A
missing source-required grant, grantability change, unapproved role/schema/table, malformed
evidence, or any other extra privilege fails with `TABLE_GRANT_PORTABILITY_COMPATIBILITY_FAILED`.
All differences are planned before any SQL runs; a transactional revoke is followed by fresh
catalog collection requiring exact table-grant parity. The validated batch is streamed to psql's
standard input as `postgres`, retaining `ON_ERROR_STOP` and one transaction. This avoids Windows
command-line limits: the observed 429-statement batch contained 33,833 characters and failed with
`ENAMETOOLONG` before psql started. Catalog inspection confirmed that `postgres` was both
owner and grantor with revoke authority; no role elevation or ownership change is needed. An
injected mid-transaction failure rolled back the whole batch in the disposable proof. Diagnostics
contain fixed codes and counts.

The verifier-owned synthetic source establishes the twelve PostgreSQL 17 high-impact default ACL
entries only after repository migrations have created the historical tables, proves those existing
table ACLs remain unchanged, and captures through the ordinary recovery path. The rehearsal must
observe target-only grants after fresh schema replay, revoke only the recognized extras, preserve
every source-required grant, and retain the checksum-valid bundle unchanged. The fixture requires
matching disposable ownership marker, workdir, project identity, and running container labels; no
operator Local or hosted capture option can enable it.

The independent PG17 capture/replay proof observed 15 source high-impact grants, twelve high-impact
default ACL entries already on the bare target, and 429 target-only grants after schema replay.
The dump's default-ACL statements occur after table creation; the fresh target's pre-existing
defaults cause the inherited overgrants. Revoking only those extras preserved all 15 legitimate
source grants and produced exact parity with zero missing grants.

Post-recovery security follow-up: separately review and harden public table default ACLs. Migration
`20260719003407` narrows existing table access but its default-ACL revocation names only CRUD
privileges. This recovery change adds no migration and preserves the 48-migration acceptance source.

The ordinary Gate 4 comparator remains exact. Recovery accepts only the five fixed, directional
constraint definition pairs in `constraintRenderingCompatibility.ts`, with no version or source-kind
exemption. Fresh PG17 migrations reproduce the supplied hosted definitions exactly. Replaying the
ordinary dump on PG17 flattens the nested `AND` grouping introduced by migration `BETWEEN`
expressions. Only association changes; operands, casts, bounds, regexes, NULL handling, and role
values remain identical. Existing catalog canonicalization does not erase that inner grouping.

Both definitions must independently match their reviewed form, only `definition` may differ, all
five known constraints must exist, both repository contracts must pass, and every other Gate 4
category (including table grants) must match. Arbitrary edits on those keys, missing/extra
constraints, additional changed fields, and truncated comparisons fail closed. Successful rendering
portability reports `GATE4_MATCH_CONSTRAINT_RENDERING_PORTABLE` and a bounded pair count; the full
synthetic rehearsal requires all five actual dump-replay pairs.

## Timing language

Record only:

- `BACKUP_DURATION_MS`;
- `BACKUP_AGE_AT_RESTORE_START_MS`;
- `ZERO_COST_ISOLATED_RESTORE_DURATION_MS`; and
- `FULL_RECOVERY_VERIFICATION_DURATION_MS`.

Never relabel them as `HOSTED_RTO`, `PRODUCTION_RTO`, `MANAGED_RESTORE_RTO`, or provider RPO. A real
hosted-origin capture and independently reviewed isolated restore are still required before PP1 can
claim a supervised hosted-origin rehearsal.
