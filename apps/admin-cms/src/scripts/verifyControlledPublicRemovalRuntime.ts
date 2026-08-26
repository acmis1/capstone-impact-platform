import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getPermissionsForRoles } from '../auth/permissions';
import { executeControlledPublication } from '../projects/controlledPublicationService';
import { executeControlledPublicRemoval } from '../projects/controlledPublicRemovalService';
import { createControlledPublicationDependencies } from '../projects/createControlledPublicationDependencies';
import { createControlledPublicRemovalDependencies } from '../projects/createControlledPublicRemovalDependencies';
import { inspectPublicFeedHead } from '../projects/publicFeedWriterCoordinator';
import {
  createPublicFeedRuntimeHarness,
  createScenarioRunner,
  PUBLIC_ASSETS_BUCKET,
  PUBLIC_FEED_BUCKET,
  PUBLIC_FEED_PATH,
  PRIVATE_BUCKET,
  type RuntimeFixture,
} from './publicFeedRuntimeSupport';

/**
 * Service-level controlled public removal runtime verification.
 *
 * Reverse compensation over `public_removal_attempts` no longer exists, so the removal contract
 * verified here is the ledger one: authorization, lifecycle archive with its audit record, exact
 * feed composition off the deployed head, and completion evidence that belongs to the requested
 * target rather than to whichever operation currently owns the head.
 */

async function main(): Promise<void> {
  console.log('=== Controlled Public Removal Local Supabase Runtime Verification ===');
  const harness = await createPublicFeedRuntimeHarness();
  const { db, apiUrl, adminId, reviewerId, psql, quoted, storedFeed, count } = harness;
  const prefix = `controlled-removal-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const { scenario, passed } = createScenarioRunner();

  const publish = (fixture: RuntimeFixture) => executeControlledPublication({
    permissions: getPermissionsForRoles(['admin']), publicId: fixture.publicId,
    privateBucket: PRIVATE_BUCKET, publicAssetsBucket: PUBLIC_ASSETS_BUCKET,
    publicFeedBucket: PUBLIC_FEED_BUCKET, publicFeedPath: PUBLIC_FEED_PATH,
    dependencies: createControlledPublicationDependencies({
      supabase: db, supabaseUrl: apiUrl, publicId: fixture.publicId, adminId,
      privateBucket: PRIVATE_BUCKET, publicFeedBucket: PUBLIC_FEED_BUCKET,
      publicFeedPath: PUBLIC_FEED_PATH, executionTarget: 'local',
    }),
  });
  const remove = (
    fixture: RuntimeFixture,
    role: 'admin' | 'reviewer' | 'editor' = 'admin',
    archiveReason = `Archive ${fixture.publicId}`,
  ) => executeControlledPublicRemoval({
    permissions: getPermissionsForRoles([role]), publicId: fixture.publicId, archiveReason,
    dependencies: createControlledPublicRemovalDependencies({
      supabase: db, supabaseUrl: apiUrl, publicId: fixture.publicId,
      adminId: role === 'admin' ? adminId : reviewerId,
      feedBucket: PUBLIC_FEED_BUCKET, feedPath: PUBLIC_FEED_PATH,
      executionTarget: 'local',
    }),
  });
  const deployedIds = async (): Promise<string[]> => {
    const inspected = await inspectPublicFeedHead(db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
    return (inspected.artifact?.members ?? []).map((member) => member.publicId);
  };

  await scenario(1, 'the pre-ledger removal attempt protocol stays permanently fail closed', async () => {
    const legacy = await db.rpc('reserve_public_removal_attempt', {
      p_public_id: 'synthetic-legacy', p_admin_id: adminId, p_archive_reason: 'Synthetic',
    });
    assert.equal((legacy.data as { resultCode?: string })?.resultCode, 'LEDGER_PROTOCOL_REQUIRED');
  });

  await harness.ensureActiveHead();

  const target = await harness.makeReady(`${prefix}-target`);
  assert.equal((await publish(target)).resultCode, 'COMPLETED');

  await scenario(2, 'an editor cannot remove a deployed project', async () => {
    assert.equal((await remove(target, 'editor')).resultCode, 'PERMISSION_DENIED');
    assert.ok((await deployedIds()).includes(target.publicId));
  });

  const draft = await harness.createProject(`${prefix}-draft`, 'draft');
  await scenario(3, 'a project that was never deployed is refused', async () => {
    const before = await storedFeed();
    assert.equal((await remove(draft)).resultCode, 'NOT_PUBLISHED');
    assert.ok((await storedFeed())?.equals(before!), 'A refused removal changed the canonical feed.');
  });

  await scenario(4, 'removal archives the lifecycle record and recomposes the deployed head', async () => {
    const result = await remove(target);
    assert.equal(result.resultCode, 'COMPLETED', JSON.stringify(result));
    assert.equal(psql(`SELECT status FROM public.projects WHERE id=${quoted(target.id)}::uuid;`), 'archived');
    assert.equal(await count('approval_records', 'project_id', target.id), 2);
    assert.equal(psql(`SELECT archive_reason FROM public.projects WHERE id=${quoted(target.id)}::uuid;`), `Archive ${target.publicId}`);
    assert.equal((await deployedIds()).includes(target.publicId), false);
    const inspected = await inspectPublicFeedHead(db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
    assert.equal(inspected.artifact!.content, inspected.head!.currentVersion.artifactContent);
  });

  const laterTarget = await harness.makeReady(`${prefix}-later`);
  await scenario(5, 'a later unrelated feed change does not become the removed target evidence', async () => {
    assert.equal((await publish(laterTarget)).resultCode, 'COMPLETED');
    const headOperation = psql(`SELECT o.id::text FROM public.public_feed_head h
      JOIN public.public_feed_versions v ON v.id = h.current_version_id
      JOIN public.public_feed_operations o ON o.id = v.operation_id WHERE h.singleton = true;`);
    const retry = await remove(target);
    assert.equal(retry.resultCode, 'ALREADY_COMPLETED', JSON.stringify(retry));
    if (retry.resultCode !== 'ALREADY_COMPLETED') throw new Error('TARGET_EVIDENCE_FAILED');
    const evidence = psql(`SELECT operation_id::text FROM public.public_feed_versions
      WHERE operation='removal' AND affected_public_id=${quoted(target.publicId)}
      ORDER BY version_number DESC LIMIT 1;`);
    assert.equal(retry.attemptId, evidence, 'The retry did not answer with the target own removal.');
    assert.notEqual(retry.attemptId, headOperation, 'The retry borrowed the current head operation.');
    assert.equal(await count('approval_records', 'project_id', target.id), 2, 'An idempotent retry re-archived the project.');
  });

  await scenario(6, 'an archived target that was never deployed completes without a feed change', async () => {
    const neverDeployed = await harness.createProject(`${prefix}-never-deployed`, 'archived');
    const versionsBefore = psql('SELECT count(*) FROM public.public_feed_versions;');
    const result = await remove(neverDeployed);
    assert.ok(['COMPLETED', 'ALREADY_COMPLETED'].includes(result.resultCode), JSON.stringify(result));
    if (result.resultCode !== 'COMPLETED' && result.resultCode !== 'ALREADY_COMPLETED') throw new Error('NO_CHANGE_FAILED');
    assert.equal(result.auditRecordId, null, 'A no-change removal invented an audit identifier.');
    assert.equal(psql('SELECT count(*) FROM public.public_feed_versions;'), versionsBefore);
  });

  await scenario(7, 'publication and removal share one global canonical writer', async () => {
    const contender = await harness.makeReady(`${prefix}-contender`);
    const [publication, removal] = await Promise.all([publish(contender), remove(laterTarget)]);
    const completed = [publication, removal].filter((result) => result.resultCode === 'COMPLETED');
    assert.equal(completed.length, 1, JSON.stringify([publication, removal]));
    assert.equal([publication, removal].filter((result) => result.resultCode === 'PUBLICATION_IN_PROGRESS').length, 1);
    assert.equal(psql(`SELECT count(*) FROM public.public_feed_operations
      WHERE state IN ('RESERVED','PREPARED','WRITE_STARTED','CANDIDATE_OBSERVED','DB_FINALIZED','RECOVERY_REQUIRED');`), '0');
  });

  await scenario(8, 'the canonical object stays byte-identical to the deployed head', async () => {
    const inspected = await inspectPublicFeedHead(db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
    assert.ok(inspected.artifact && inspected.head);
    assert.equal(inspected.artifact!.recordCount, inspected.head!.currentVersion.recordCount);
    assert.equal(inspected.artifact!.feedHash, inspected.head!.currentVersion.feedHash);
  });

  console.log(`OVERALL CONTROLLED PUBLIC REMOVAL RUNTIME VERIFICATION RESULT: PASS (${passed()} scenarios)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
