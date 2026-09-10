import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getPermissionsForRoles } from '../auth/permissions';
import { composePublicFeedRemoval, verifyPublicFeedArtifact } from '../feed/publicFeedArtifact';
import { executeControlledPublication } from '../projects/controlledPublicationService';
import { executeControlledPublicRemoval } from '../projects/controlledPublicRemovalService';
import { createControlledPublicationDependencies } from '../projects/createControlledPublicationDependencies';
import { createControlledPublicRemovalDependencies } from '../projects/createControlledPublicRemovalDependencies';
import { executePublicFeedWriter, inspectPublicFeedHead } from '../projects/publicFeedWriterCoordinator';
import { SupabasePublicFeedLedgerRepositoryCore } from '../repositories/SupabasePublicFeedLedgerRepositoryCore';
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
  const wrongAdminId = crypto.randomUUID();
  const wrongAdminEmail = `issue-268-other-admin-${wrongAdminId}@example.invalid`;
  // This scenario needs a genuine active administrator who is not the operation owner.
  // A role-only fixture now correctly fails Migration 0053 lifecycle authority before ownership.
  const wrongAdminAuth = await db.auth.admin.createUser({ email: wrongAdminEmail, email_confirm: true });
  assert.equal(wrongAdminAuth.error, null, wrongAdminAuth.error?.message);
  assert.ok(wrongAdminAuth.data.user?.id);
  psql(`INSERT INTO public.admin_users(id,auth_user_id,email,full_name)
    VALUES (${quoted(wrongAdminId)}::uuid,${quoted(wrongAdminAuth.data.user.id)}::uuid,
      ${quoted(wrongAdminEmail)},'Issue 268 Other Admin');
    INSERT INTO public.user_roles(user_id,role) VALUES (${quoted(wrongAdminId)}::uuid,'admin');`);
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
  const ledger = new SupabasePublicFeedLedgerRepositoryCore(db);
  const projectRemovalState = (fixture: RuntimeFixture): string => psql(`
    SELECT status || '|' || COALESCE(archived_from_status,'') || '|'
      || pending_removal_from_public::text || '|'
      || COALESCE(public_removal_completed_at::text,'')
      FROM public.projects WHERE id=${quoted(fixture.id)}::uuid;
  `);
  const stageRemovalThroughFinalization = async (
    fixture: RuntimeFixture,
    archiveReason: string,
  ) => {
    const head = await ledger.getHead();
    assert.ok(head);
    const baseline = verifyPublicFeedArtifact(head.currentVersion.artifactContent);
    const candidate = composePublicFeedRemoval(baseline, fixture.publicId);
    assert.notEqual(candidate.content, baseline.content, 'The boundary fixture must remove a deployed target.');
    const ownerToken = crypto.randomBytes(32).toString('base64url');
    const reserved = await ledger.reserve({
      operationKey: crypto.randomUUID(), kind: 'removal', mode: null,
      adminId, publicId: fixture.publicId, ownerToken, archiveReason,
      storageBucket: PUBLIC_FEED_BUCKET, storagePath: PUBLIC_FEED_PATH,
      rollbackCapability: false,
    });
    assert.equal(reserved.resultCode, 'OPERATION_RESERVED');
    const operationId = String(reserved.operationId);
    const epoch = Number(reserved.ownerEpoch);
    const bound = await ledger.bind({
      operationId, epoch, token: ownerToken, actorId: adminId,
      baselineVersionId: head.currentVersion.id, baselineStorageExisted: true,
      baselineHash: baseline.feedHash, baselineCount: baseline.recordCount,
      baselineContent: baseline.content, candidateHash: candidate.feedHash,
      candidateCount: candidate.recordCount, candidateContent: candidate.content,
      candidateMembers: candidate.members,
      feedPublicUrl: `${apiUrl}/storage/v1/object/public/${PUBLIC_FEED_BUCKET}/${PUBLIC_FEED_PATH}`,
      mediaManifest: [],
    });
    assert.equal(bound.resultCode, 'ARTIFACT_BOUND');
    assert.equal(
      (await ledger.markWriteStarted(operationId, epoch, ownerToken, adminId)).resultCode,
      'WRITE_STARTED',
    );
    const uploaded = await db.storage.from(PUBLIC_FEED_BUCKET).upload(PUBLIC_FEED_PATH, candidate.bytes, {
      contentType: 'application/json', upsert: true,
    });
    assert.equal(uploaded.error, null, uploaded.error?.message);
    assert.equal(
      (await ledger.observeCandidate(
        operationId, epoch, ownerToken, adminId, candidate.feedHash, candidate.recordCount,
      )).resultCode,
      'CANDIDATE_OBSERVED',
    );
    assert.equal(
      (await ledger.finalize(operationId, epoch, ownerToken, adminId)).resultCode,
      'DB_FINALIZED',
    );
    return { operationId, epoch, ownerToken, candidate, archiveReason };
  };

  await scenario(1, 'the pre-ledger removal attempt protocol stays permanently fail closed', async () => {
    const legacy = await db.rpc('reserve_public_removal_attempt', {
      p_public_id: 'synthetic-legacy', p_admin_id: adminId, p_archive_reason: 'Synthetic',
    });
    assert.equal((legacy.data as { resultCode?: string })?.resultCode, 'LEDGER_PROTOCOL_REQUIRED');
  });

  await harness.ensureActiveHead();

  const diverged = await harness.createProject(`${prefix}-diverged`, 'published');
  await scenario(2, 'a lifecycle-published target absent from the deployed baseline fails before mutation', async () => {
    const feedBefore = await storedFeed();
    const versionsBefore = psql('SELECT count(*) FROM public.public_feed_versions;');
    const auditsBefore = await count('approval_records', 'project_id', diverged.id);
    const result = await remove(diverged);
    assert.deepEqual(result, { resultCode: 'EXECUTION_FAILED', failureCode: 'CURRENT_FEED_DIVERGED' });
    assert.ok((await storedFeed())?.equals(feedBefore!), 'Divergence attempted a Storage write.');
    assert.equal(psql('SELECT count(*) FROM public.public_feed_versions;'), versionsBefore);
    assert.equal(psql(`SELECT status FROM public.projects WHERE id=${quoted(diverged.id)}::uuid;`), 'published');
    assert.equal(await count('approval_records', 'project_id', diverged.id), auditsBefore);
    assert.equal(psql(`SELECT count(*) FROM public.public_feed_versions
      WHERE operation='removal' AND affected_public_id=${quoted(diverged.publicId)};`), '0');
  });

  const anchor = await harness.makeReady(`${prefix}-anchor`);
  assert.equal((await publish(anchor)).resultCode, 'COMPLETED');

  const target = await harness.makeReady(`${prefix}-target`);
  assert.equal((await publish(target)).resultCode, 'COMPLETED');

  await scenario(3, 'an editor cannot remove a deployed project', async () => {
    assert.equal((await remove(target, 'editor')).resultCode, 'PERMISSION_DENIED');
    assert.ok((await deployedIds()).includes(target.publicId));
  });

  const draft = await harness.createProject(`${prefix}-draft`, 'draft');
  await scenario(4, 'a project that was never deployed is refused', async () => {
    const before = await storedFeed();
    assert.equal((await remove(draft)).resultCode, 'NOT_PUBLISHED');
    assert.ok((await storedFeed())?.equals(before!), 'A refused removal changed the canonical feed.');
  });

  const boundaryTarget = await harness.makeReady(`${prefix}-atomic-boundary`);
  assert.equal((await publish(boundaryTarget)).resultCode, 'COMPLETED');
  const unrelatedArchived = await harness.createProject(`${prefix}-unrelated-archived`, 'archived');
  psql(`UPDATE public.projects SET archived_from_status='published', archived_at=pg_catalog.now(),
    archive_reason='Unrelated historical pending row', pending_removal_from_public=true,
    public_removal_completed_at=NULL WHERE id=${quoted(unrelatedArchived.id)}::uuid;`);

  await scenario(5, 'DB finalization stays pending until exact atomic completion authority succeeds', async () => {
    const staged = await stageRemovalThroughFinalization(boundaryTarget, 'Atomic boundary removal');
    assert.equal(projectRemovalState(boundaryTarget), 'archived|published|true|');
    assert.equal(
      psql(`SELECT state || '|' || COALESCE(completed_at::text,'') FROM public.public_feed_operations
        WHERE id=${quoted(staged.operationId)}::uuid;`),
      'DB_FINALIZED|',
    );

    const mismatch = await ledger.complete(
      staged.operationId, staged.epoch, staged.ownerToken, adminId, 'f'.repeat(64),
      staged.candidate.recordCount + 1,
    );
    assert.equal(mismatch.resultCode, 'OBSERVATION_MISMATCH');
    assert.equal(projectRemovalState(boundaryTarget), 'archived|published|true|');

    const stale = await ledger.complete(
      staged.operationId, staged.epoch, crypto.randomBytes(32).toString('base64url'), adminId,
      staged.candidate.feedHash, staged.candidate.recordCount,
    );
    assert.equal(stale.resultCode, 'STALE_OWNER');
    assert.equal(projectRemovalState(boundaryTarget), 'archived|published|true|');

    const wrongActor = await ledger.complete(
      staged.operationId, staged.epoch, staged.ownerToken, wrongAdminId,
      staged.candidate.feedHash, staged.candidate.recordCount,
    );
    assert.equal(wrongActor.resultCode, 'STALE_OWNER');
    assert.equal(projectRemovalState(boundaryTarget), 'archived|published|true|');

    const denied = await ledger.complete(
      staged.operationId, staged.epoch, staged.ownerToken, reviewerId,
      staged.candidate.feedHash, staged.candidate.recordCount,
    );
    assert.equal(denied.resultCode, 'PERMISSION_DENIED');
    assert.equal(projectRemovalState(boundaryTarget), 'archived|published|true|');

    psql(`BEGIN;
      SELECT pg_catalog.set_config('app.public_feed_operation_id',${quoted(staged.operationId)},true);
      UPDATE public.projects SET status='draft' WHERE id=${quoted(boundaryTarget.id)}::uuid;
      COMMIT;`);
    const incompatible = await ledger.complete(
      staged.operationId, staged.epoch, staged.ownerToken, adminId,
      staged.candidate.feedHash, staged.candidate.recordCount,
    );
    assert.equal(incompatible.resultCode, 'INVALID_PROJECT_STATE');
    assert.equal(projectRemovalState(boundaryTarget), 'draft|published|true|');
    assert.equal(psql(`SELECT state FROM public.public_feed_operations WHERE id=${quoted(staged.operationId)}::uuid;`), 'DB_FINALIZED');
    psql(`BEGIN;
      SELECT pg_catalog.set_config('app.public_feed_operation_id',${quoted(staged.operationId)},true);
      UPDATE public.projects SET status='archived' WHERE id=${quoted(boundaryTarget.id)}::uuid;
      COMMIT;`);

    const completed = await ledger.complete(
      staged.operationId, staged.epoch, staged.ownerToken, adminId,
      staged.candidate.feedHash, staged.candidate.recordCount,
    );
    assert.equal(completed.resultCode, 'COMPLETED');
    const completedState = projectRemovalState(boundaryTarget);
    assert.match(completedState, /^archived\|published\|false\|.+/);
    const operationCompletion = psql(`SELECT state || '|' || completed_at::text
      FROM public.public_feed_operations WHERE id=${quoted(staged.operationId)}::uuid;`);
    assert.equal(operationCompletion, `COMPLETED|${completedState.split('|')[3]}`);
    assert.equal(projectRemovalState(unrelatedArchived), 'archived|published|true|');

    const mapped = (await harness.projects.listProjects())
      .find((project) => project.publicId === boundaryTarget.publicId);
    assert.ok(mapped);
    assert.equal(
      mapped.pendingRemovalFromPublic,
      false,
      'The Admin/CMS workflow input still reports “Showcase removal pending.”',
    );
    assert.equal(
      Date.parse(mapped.publicRemovalCompletedAt ?? ''),
      Date.parse(completedState.split('|')[3]),
    );

    const completionEventsBefore = psql(`SELECT count(*) FROM public.public_feed_operation_events
      WHERE operation_id=${quoted(staged.operationId)}::uuid AND to_state='COMPLETED';`);
    const versionsBeforeReplay = psql('SELECT count(*) FROM public.public_feed_versions;');
    const auditsBeforeReplay = await count('approval_records', 'project_id', boundaryTarget.id);
    assert.equal((await ledger.complete(
      staged.operationId, staged.epoch, staged.ownerToken, adminId,
      staged.candidate.feedHash, staged.candidate.recordCount,
    )).resultCode, 'COMPLETED');
    assert.equal(projectRemovalState(boundaryTarget), completedState);
    assert.equal(psql('SELECT count(*) FROM public.public_feed_versions;'), versionsBeforeReplay);
    assert.equal(await count('approval_records', 'project_id', boundaryTarget.id), auditsBeforeReplay);
    assert.equal(psql(`SELECT count(*) FROM public.public_feed_operation_events
      WHERE operation_id=${quoted(staged.operationId)}::uuid AND to_state='COMPLETED';`), completionEventsBefore);
  });

  const recoveryTarget = await harness.makeReady(`${prefix}-recovery`);
  assert.equal((await publish(recoveryTarget)).resultCode, 'COMPLETED');

  await scenario(6, 'RECOVERY_REQUIRED stays pending and explicit forward recovery reaches the same completion authority', async () => {
    const publicMediaRowsBefore = psql(`SELECT count(*) FROM storage.objects
      WHERE bucket_id=${quoted(PUBLIC_ASSETS_BUCKET)};`);
    const staged = await stageRemovalThroughFinalization(recoveryTarget, 'Explicit recovery removal');
    assert.equal((await ledger.requireRecovery(
      staged.operationId, staged.epoch, staged.ownerToken, adminId,
      'SIMULATED_STORAGE_UNCERTAINTY', staged.candidate.feedHash, staged.candidate.recordCount,
    )).resultCode, 'RECOVERY_REQUIRED');
    assert.equal(projectRemovalState(recoveryTarget), 'archived|published|true|');
    assert.equal(psql(`SELECT state FROM public.public_feed_operations WHERE id=${quoted(staged.operationId)}::uuid;`), 'RECOVERY_REQUIRED');

    const versionsBeforeRecovery = psql('SELECT count(*) FROM public.public_feed_versions;');
    const headGenerationBeforeRecovery = psql('SELECT generation FROM public.public_feed_head WHERE singleton=true;');
    const auditsBeforeRecovery = await count('approval_records', 'project_id', recoveryTarget.id);
    psql(`UPDATE public.public_feed_operations SET lease_expires_at=pg_catalog.now() - interval '1 second'
      WHERE id=${quoted(staged.operationId)}::uuid;`);
    const recovered = await executePublicFeedWriter({
      supabase: db, adminId, kind: 'removal', publicId: recoveryTarget.publicId,
      archiveReason: staged.archiveReason, feedBucket: PUBLIC_FEED_BUCKET,
      feedPath: PUBLIC_FEED_PATH, recoveryOperationId: staged.operationId,
      prepareCandidate: async () => { throw new Error('Recovery replaced its bound candidate.'); },
    });
    assert.equal(recovered.resultCode, 'COMPLETED', JSON.stringify(recovered));
    const recoveredState = projectRemovalState(recoveryTarget);
    assert.match(recoveredState, /^archived\|published\|false\|.+/);
    assert.equal(psql(`SELECT state || '|' || completed_at::text FROM public.public_feed_operations
      WHERE id=${quoted(staged.operationId)}::uuid;`), `COMPLETED|${recoveredState.split('|')[3]}`);
    assert.equal(psql('SELECT count(*) FROM public.public_feed_versions;'), versionsBeforeRecovery);
    assert.equal(psql('SELECT generation FROM public.public_feed_head WHERE singleton=true;'), headGenerationBeforeRecovery);
    assert.equal(await count('approval_records', 'project_id', recoveryTarget.id), auditsBeforeRecovery);
    assert.equal(psql(`SELECT count(*) FROM storage.objects
      WHERE bucket_id=${quoted(PUBLIC_ASSETS_BUCKET)};`), publicMediaRowsBefore);
    assert.ok((await storedFeed())?.equals(staged.candidate.bytes), 'Recovery did not preserve the exact forward candidate.');
  });

  await scenario(7, 'removal archives the lifecycle record and preserves unrelated feed records byte-for-byte', async () => {
    const before = await inspectPublicFeedHead(db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
    const unrelatedBefore = before.artifact!.feed
      .filter((record) => record.publicId !== target.publicId)
      .map((record) => JSON.stringify(record));
    const result = await remove(target);
    assert.equal(result.resultCode, 'COMPLETED', JSON.stringify(result));
    assert.equal(psql(`SELECT status FROM public.projects WHERE id=${quoted(target.id)}::uuid;`), 'archived');
    assert.match(projectRemovalState(target), /^archived\|published\|false\|.+/);
    assert.equal(await count('approval_records', 'project_id', target.id), 2);
    assert.equal(psql(`SELECT archive_reason FROM public.projects WHERE id=${quoted(target.id)}::uuid;`), `Archive ${target.publicId}`);
    assert.equal((await deployedIds()).includes(target.publicId), false);
    const inspected = await inspectPublicFeedHead(db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
    assert.equal(inspected.artifact!.content, inspected.head!.currentVersion.artifactContent);
    assert.deepEqual(
      inspected.artifact!.feed.map((record) => JSON.stringify(record)),
      unrelatedBefore,
      'Removal rewrote an unrelated feed member.',
    );
  });

  const laterTarget = await harness.makeReady(`${prefix}-later`);
  await scenario(8, 'a later unrelated feed change does not become the removed target evidence', async () => {
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

  await scenario(9, 'an archived pending target absent from the feed completes without a feed change', async () => {
    const neverDeployed = await harness.createProject(`${prefix}-never-deployed`, 'archived');
    psql(`UPDATE public.projects SET archived_from_status='published', archived_at=pg_catalog.now(),
      archive_reason='No-change removal', pending_removal_from_public=true,
      public_removal_completed_at=NULL WHERE id=${quoted(neverDeployed.id)}::uuid;`);
    const versionsBefore = psql('SELECT count(*) FROM public.public_feed_versions;');
    const result = await remove(neverDeployed);
    assert.ok(['COMPLETED', 'ALREADY_COMPLETED'].includes(result.resultCode), JSON.stringify(result));
    if (result.resultCode !== 'COMPLETED' && result.resultCode !== 'ALREADY_COMPLETED') throw new Error('NO_CHANGE_FAILED');
    assert.equal(result.auditRecordId, null, 'A no-change removal invented an audit identifier.');
    assert.equal(psql('SELECT count(*) FROM public.public_feed_versions;'), versionsBefore);
    assert.match(projectRemovalState(neverDeployed), /^archived\|published\|false\|.+/);
  });

  await scenario(10, 'publication and removal share one global canonical writer', async () => {
    const contender = await harness.makeReady(`${prefix}-contender`);
    const [publication, removal] = await Promise.all([publish(contender), remove(laterTarget)]);
    const completed = [publication, removal].filter((result) => result.resultCode === 'COMPLETED');
    assert.equal(completed.length, 1, JSON.stringify([publication, removal]));
    assert.equal([publication, removal].filter((result) => result.resultCode === 'PUBLICATION_IN_PROGRESS').length, 1);
    assert.equal(psql(`SELECT count(*) FROM public.public_feed_operations
      WHERE state IN ('RESERVED','PREPARED','WRITE_STARTED','CANDIDATE_OBSERVED','DB_FINALIZED','RECOVERY_REQUIRED');`), '0');
  });

  await scenario(11, 'the canonical object stays byte-identical to the deployed head', async () => {
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
