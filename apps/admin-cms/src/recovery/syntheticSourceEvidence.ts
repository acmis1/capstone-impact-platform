import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CANONICAL_STORAGE_BUCKETS } from './zeroCostRecoveryContract';

/**
 * Representative synthetic evidence for the disposable rehearsal source.
 *
 * The reviewed `infra/supabase/seed.sql` already establishes programs, an import batch, projects,
 * and media metadata. This adds the operational rows the recovery contract must prove survive:
 * review history, validation findings, a publication ledger artifact, participant preview state,
 * assistive results, and the assistive cost-fence state. Everything is synthetic; no real
 * participant or staff identity is ever used.
 */

export const SYNTHETIC_DEPLOYMENT_VERSION = 'a'.repeat(40);
export const SYNTHETIC_IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;
export const SYNTHETIC_AUTH_EMAIL = 'recovery-rehearsal@synthetic.invalid';

/** Deterministic 64-hex value so repeated runs produce identical structural evidence. */
function syntheticHash(seed: string): string {
  return createHash('sha256').update(`zero-cost-recovery:${seed}`).digest('hex');
}

/**
 * One statement per row set. `supabase db query` sends a prepared statement, so these run through
 * psql on the disposable source instead, where multiple commands are fine.
 */
export function buildSyntheticSourceSeedSql(): string {
  return `
BEGIN;

INSERT INTO public.admin_users (email, full_name, auth_user_id)
SELECT email, 'Synthetic Recovery Operator', id
FROM auth.users
WHERE email = '${SYNTHETIC_AUTH_EMAIL}'
ON CONFLICT (email) DO NOTHING;

WITH target AS (
  SELECT id FROM public.projects ORDER BY public_id LIMIT 1
), operator AS (
  SELECT id FROM public.admin_users WHERE email = '${SYNTHETIC_AUTH_EMAIL}'
)
INSERT INTO public.approval_records (project_id, admin_id, action_taken, comments)
SELECT target.id, operator.id, 'submit_for_review', 'Synthetic recovery rehearsal review history.'
FROM target CROSS JOIN operator;

WITH target AS (
  SELECT id FROM public.projects ORDER BY public_id LIMIT 1
)
INSERT INTO public.validation_flags (project_id, severity, rule_code, message)
SELECT target.id, 'warning', 'RECOVERY_REHEARSAL_SYNTHETIC', 'Synthetic recovery rehearsal validation flag.' FROM target;

INSERT INTO public.published_snapshots
  (feed_file_name, storage_bucket, storage_path, public_url, record_count, feed_hash)
VALUES (
  'capstones-latest.json',
  'public-feeds',
  'recovery-rehearsal/capstones-latest.json',
  'http://127.0.0.1/storage/v1/object/public/public-feeds/recovery-rehearsal/capstones-latest.json',
  1,
  '${syntheticHash('feed')}'
);

WITH operator AS (
  SELECT id FROM public.admin_users WHERE email = '${SYNTHETIC_AUTH_EMAIL}'
), inserted_operation AS (
  INSERT INTO public.public_feed_operations (
    operation_key, kind, authorizing_actor_id, completion_actor_id, state,
    owner_token_hash, lease_expires_at, finalized_at, completed_at
  )
  SELECT gen_random_uuid(), 'activation', operator.id, operator.id, 'COMPLETED',
         '${syntheticHash('public-feed-owner')}', now() + interval '1 hour', now(), now()
  FROM operator
  RETURNING id, authorizing_actor_id, completion_actor_id
)
INSERT INTO public.public_feed_versions (
  operation, operation_id, authorizing_actor_id, completion_actor_id,
  artifact_content, byte_count, feed_hash, record_count
)
SELECT 'baseline', inserted_operation.id, inserted_operation.authorizing_actor_id,
       inserted_operation.completion_actor_id, '{"records":[]}', 14,
       '${syntheticHash('public-feed-baseline')}', 0
FROM inserted_operation;

WITH target AS (
  SELECT id FROM public.projects ORDER BY public_id LIMIT 1
)
INSERT INTO public.participant_previews (project_id, token_hash, snapshot, expires_at)
SELECT
  target.id,
  '${syntheticHash('preview-token')}',
  jsonb_build_object('scope', 'synthetic-recovery-rehearsal'),
  now() + interval '30 days'
FROM target;

WITH target AS (
  SELECT id FROM public.projects ORDER BY public_id LIMIT 1
)
INSERT INTO public.assistive_validation_runs
  (project_id, input_hash, pipeline_version, status, completed_at)
SELECT target.id, '${syntheticHash('assistive-input')}', 'assistive-deterministic-checks/v3', 'COMPLETED', now()
FROM target;

INSERT INTO public.assistive_validation_findings
  (run_id, check_type, outcome, reason_code, affected_field, origin, ordinal, evidence)
SELECT
  runs.id, 'TITLE_CONSISTENCY', 'AGREES', 'NORMALIZED_EXACT_MATCH', 'title',
  'DETERMINISTIC_HELPER', 1,
  jsonb_build_object(
    'version', 'assistive-finding-evidence/v1',
    'evidenceExcerpt', null,
    'pageNumber', null,
    'boundingBox', null,
    'metadataValue', 'Synthetic recovery title',
    'normalizedMetadataValue', 'synthetic recovery title',
    'candidateValue', 'Synthetic recovery title',
    'normalizedCandidateValue', 'synthetic recovery title',
    'explanation', 'Synthetic deterministic agreement for recovery rehearsal.'
  )
FROM public.assistive_validation_runs runs
ORDER BY runs.created_at DESC
LIMIT 1;

INSERT INTO assistive_execution_control.executor_registrations (
  environment, execution_mode, pipeline_version, deployment_version, image_digest,
  ocr_capability, language_capability, configuration_version, registered_at, expires_at
) VALUES (
  'staging', 'ON_DEMAND', 'assistive-deterministic-checks/v3',
  '${SYNTHETIC_DEPLOYMENT_VERSION}', '${SYNTHETIC_IMAGE_DIGEST}',
  'paddle-title/pp-ocrv6-small@3.7.0', 'languagetool/en-au@6.6',
  'recovery-rehearsal/v1', now(), now() + interval '30 days'
);

-- Two consumed launch units inside the rolling window. Recovery must preserve both: dropping them
-- would silently hand back budget against the 40-start fence.
INSERT INTO assistive_execution_control.launch_reservations (
  environment, execution_mode, generation, dispatcher_instance_id, deployment_version,
  image_digest, state, counts_against_budget, reserved_at, expires_at, outcome_code, settled_at
) VALUES
  ('staging', 'ON_DEMAND', 1, 'recovery-rehearsal-dispatcher-1', '${SYNTHETIC_DEPLOYMENT_VERSION}',
   '${SYNTHETIC_IMAGE_DIGEST}', 'COMPLETED', true, now() - interval '5 days',
   now() - interval '5 days' + interval '1 hour', 'COMPLETED', now() - interval '5 days' + interval '10 minutes'),
  ('staging', 'ON_DEMAND', 2, 'recovery-rehearsal-dispatcher-1', '${SYNTHETIC_DEPLOYMENT_VERSION}',
   '${SYNTHETIC_IMAGE_DIGEST}', 'FAILED', true, now() - interval '2 days',
   now() - interval '2 days' + interval '1 hour', 'FAILED', now() - interval '2 days' + interval '15 minutes');

COMMIT;
`.trim();
}

export interface SyntheticStorageFixture {
  bucket: string;
  key: string;
  contentType: string;
  content: Buffer;
}

/** One object per canonical bucket, including a binary payload with non-UTF-8 bytes. */
export function buildSyntheticStorageFixtures(): SyntheticStorageFixture[] {
  return [
    {
      bucket: 'project-drafts-private',
      key: 'recovery-rehearsal/private/poster-draft.png',
      contentType: 'image/png',
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f, 0x80, 0x01]),
    },
    {
      bucket: 'project-public-assets',
      key: 'recovery-rehearsal/public/approved-poster.png',
      contentType: 'image/png',
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x10, 0x20, 0x30, 0x40]),
    },
    {
      bucket: 'public-feeds',
      key: 'recovery-rehearsal/capstones-latest.json',
      contentType: 'application/json',
      content: Buffer.from(`${JSON.stringify({ scope: 'synthetic-recovery-rehearsal', records: 1 })}\n`, 'utf8'),
    },
  ];
}

export async function seedSyntheticStorageObjects(client: SupabaseClient): Promise<number> {
  const fixtures = buildSyntheticStorageFixtures();
  const covered = new Set(fixtures.map((fixture) => fixture.bucket));
  for (const bucket of CANONICAL_STORAGE_BUCKETS) {
    if (!covered.has(bucket)) throw new Error('SYNTHETIC_STORAGE_FIXTURE_BUCKET_MISSING');
  }
  for (const fixture of fixtures) {
    const { error } = await client.storage.from(fixture.bucket).upload(fixture.key, fixture.content, {
      contentType: fixture.contentType,
      upsert: true,
    });
    if (error) throw new Error('SYNTHETIC_STORAGE_SEED_FAILED');
  }
  return fixtures.length;
}

/**
 * A single disposable Auth identity, so Auth recovery can be proven by count and relational
 * integrity without any real staging account being copied or signed in.
 */
export async function seedSyntheticAuthIdentity(client: SupabaseClient): Promise<void> {
  const { error } = await client.auth.admin.createUser({
    email: SYNTHETIC_AUTH_EMAIL,
    password: `recovery-rehearsal-${syntheticHash('auth').slice(0, 24)}`,
    email_confirm: true,
    user_metadata: { scope: 'synthetic-recovery-rehearsal' },
  });
  if (error) throw new Error('SYNTHETIC_AUTH_SEED_FAILED');
}
