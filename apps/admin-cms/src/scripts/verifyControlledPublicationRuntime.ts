import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getPermissionsForRoles } from '../auth/permissions';
import { verifyPublicFeedArtifact } from '../feed/publicFeedArtifact';
import { executeControlledPublication } from '../projects/controlledPublicationService';
import { createControlledPublicationDependencies } from '../projects/createControlledPublicationDependencies';
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
 * Service-level controlled publication runtime verification.
 *
 * The pre-ledger attempt protocol this script used to exercise — reserve/prepare/compensate over
 * `publication_attempts` — is now permanently fail closed, so what it verifies today is the
 * authorization surface of `executeControlledPublication`, its target-specific idempotency, one
 * global canonical writer, and the exact Storage/head/lifecycle agreement each success must leave.
 * Phase-by-phase crash, fencing and recovery behaviour lives in the ledger runtime verifier.
 */

async function main(): Promise<void> {
  console.log('=== Controlled Publication Local Supabase Runtime Verification ===');
  const harness = await createPublicFeedRuntimeHarness();
  const { db, apiUrl, adminId, reviewerId, psql, quoted, storedFeed, count } = harness;
  const prefix = `controlled-publication-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const { scenario, passed } = createScenarioRunner();

  const execute = (fixture: RuntimeFixture, role: 'admin' | 'reviewer' | 'editor' = 'admin') =>
    executeControlledPublication({
      permissions: getPermissionsForRoles([role]), publicId: fixture.publicId,
      privateBucket: PRIVATE_BUCKET, publicAssetsBucket: PUBLIC_ASSETS_BUCKET,
      publicFeedBucket: PUBLIC_FEED_BUCKET, publicFeedPath: PUBLIC_FEED_PATH,
      dependencies: createControlledPublicationDependencies({
        supabase: db, supabaseUrl: apiUrl, publicId: fixture.publicId,
        adminId: role === 'admin' ? adminId : reviewerId, privateBucket: PRIVATE_BUCKET,
        publicFeedBucket: PUBLIC_FEED_BUCKET, publicFeedPath: PUBLIC_FEED_PATH, executionTarget: 'local',
      }),
    });

  await scenario(1, 'the pre-ledger publication attempt protocol stays permanently fail closed', async () => {
    const legacy = await db.rpc('reserve_publication_attempt', {
      p_public_id: 'synthetic-legacy', p_admin_id: adminId, p_private_bucket: PRIVATE_BUCKET,
      p_confirmed_preview_id: crypto.randomUUID(), p_confirmed_at: new Date().toISOString(),
    });
    assert.equal((legacy.data as { resultCode?: string })?.resultCode, 'LEDGER_PROTOCOL_REQUIRED');
  });

  await harness.ensureActiveHead();

  const reviewerTarget = await harness.makeReady(`${prefix}-reviewer-denied`, prefix);
  await scenario(2, 'a reviewer cannot create any public deployment state', async () => {
    assert.equal((await execute(reviewerTarget, 'reviewer')).resultCode, 'PERMISSION_DENIED');
    assert.equal(await count('public_feed_operations', 'project_id', reviewerTarget.id), 0);
  });

  const editorTarget = await harness.makeReady(`${prefix}-editor-denied`, prefix);
  await scenario(3, 'an editor cannot create any public deployment state', async () => {
    assert.equal((await execute(editorTarget, 'editor')).resultCode, 'PERMISSION_DENIED');
    assert.equal(await count('public_feed_operations', 'project_id', editorTarget.id), 0);
  });

  const notReady = await harness.createProject(`${prefix}-not-ready`);
  await scenario(4, 'an unconfirmed target is refused without touching the canonical feed', async () => {
    const before = await storedFeed();
    assert.equal((await execute(notReady)).resultCode, 'NOT_READY');
    assert.equal(await count('public_feed_operations', 'project_id', notReady.id), 0);
    assert.ok((await storedFeed())?.equals(before!), 'A NOT_READY execution changed the canonical feed.');
  });

  const target = await harness.makeReady(`${prefix}-completed`, prefix);
  await scenario(5, 'a ready target publishes with exact Storage, head and lifecycle agreement', async () => {
    const result = await execute(target);
    assert.equal(result.resultCode, 'COMPLETED', JSON.stringify(result));
    const inspected = await inspectPublicFeedHead(db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
    assert.ok(inspected.head && inspected.artifact);
    assert.ok(inspected.artifact!.members.some((member) => member.publicId === target.publicId));
    assert.equal(psql(`SELECT status FROM public.projects WHERE id=${quoted(target.id)}::uuid;`), 'published');
    assert.equal(await count('approval_records', 'project_id', target.id), 1);
    for (const assetType of ['poster_image', 'poster_pdf']) {
      const name = assetType === 'poster_image' ? 'poster.png' : 'poster.pdf';
      const promoted = await db.storage.from(PUBLIC_ASSETS_BUCKET)
        .download(`published/${target.publicId}/${assetType}/${name}`);
      assert.equal(promoted.error, null, `Bound media was not promoted: ${assetType}`);
    }
  });

  await scenario(6, 'an exact retry is idempotent and answers with the target own evidence', async () => {
    const before = await storedFeed();
    const retry = await execute(target);
    assert.equal(retry.resultCode, 'ALREADY_COMPLETED', JSON.stringify(retry));
    if (retry.resultCode !== 'ALREADY_COMPLETED') throw new Error('RETRY_CONTRACT_FAILED');
    const evidence = psql(`SELECT operation_id::text FROM public.public_feed_versions
      WHERE operation='publication' AND affected_public_id=${quoted(target.publicId)}
      ORDER BY version_number DESC LIMIT 1;`);
    assert.equal(retry.attemptId, evidence, 'The retry did not answer with the target own operation.');
    assert.equal(await count('approval_records', 'project_id', target.id), 1);
    assert.ok((await storedFeed())?.equals(before!), 'An idempotent retry changed the canonical feed.');
  });

  const laterTarget = await harness.makeReady(`${prefix}-later-head-owner`, prefix);
  await scenario(7, 'a later unrelated publication does not rewrite the first target evidence', async () => {
    assert.equal((await execute(laterTarget)).resultCode, 'COMPLETED');
    const headOperation = psql(`SELECT o.id::text FROM public.public_feed_head h
      JOIN public.public_feed_versions v ON v.id = h.current_version_id
      JOIN public.public_feed_operations o ON o.id = v.operation_id WHERE h.singleton = true;`);
    const retry = await execute(target);
    assert.equal(retry.resultCode, 'ALREADY_COMPLETED');
    if (retry.resultCode !== 'ALREADY_COMPLETED') throw new Error('TARGET_EVIDENCE_FAILED');
    assert.notEqual(retry.attemptId, headOperation, 'The retry borrowed the current head operation.');
  });

  const raceA = await harness.makeReady(`${prefix}-race-a`, prefix);
  const raceB = await harness.makeReady(`${prefix}-race-b`, prefix);
  await scenario(8, 'one global canonical writer serializes concurrent publications', async () => {
    const results = await Promise.all([execute(raceA), execute(raceB)]);
    assert.equal(results.filter((result) => result.resultCode === 'COMPLETED').length, 1, JSON.stringify(results));
    assert.equal(results.filter((result) => result.resultCode === 'PUBLICATION_IN_PROGRESS').length, 1, JSON.stringify(results));
    const loser = results[0].resultCode === 'COMPLETED' ? raceB : raceA;
    assert.equal(psql(`SELECT status FROM public.projects WHERE id=${quoted(loser.id)}::uuid;`), 'approved');
    assert.equal((await execute(loser)).resultCode, 'COMPLETED', 'The blocked target could not publish afterwards.');
  });

  await scenario(9, 'the canonical object stays byte-identical to the deployed head', async () => {
    const inspected = await inspectPublicFeedHead(db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
    assert.ok(inspected.artifact && inspected.head);
    assert.equal(inspected.artifact!.content, inspected.head!.currentVersion.artifactContent);
    assert.equal(verifyPublicFeedArtifact((await storedFeed())!).feedHash, inspected.head!.currentVersion.feedHash);
    assert.equal(psql(`SELECT count(*) FROM public.public_feed_operations
      WHERE state IN ('RESERVED','PREPARED','WRITE_STARTED','CANDIDATE_OBSERVED','DB_FINALIZED','RECOVERY_REQUIRED');`), '0');
  });

  console.log(`OVERALL CONTROLLED PUBLICATION RUNTIME VERIFICATION RESULT: PASS (${passed()} scenarios)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
