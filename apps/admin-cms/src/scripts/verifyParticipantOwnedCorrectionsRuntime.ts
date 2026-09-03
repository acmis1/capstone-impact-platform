import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { readDisposableStackEnv, runDisposablePsql, assertDatabaseContainerOwned, type DisposableStackIdentity } from '../recovery/disposableSupabaseStack';
import { correctionForm, correctionWorkbook, ORIGINAL_PNG, ORIGINAL_PDF } from '../previews/participantCorrectionFixtures';
import { correctionDigest, parseParticipantCorrectionPackage } from '../previews/participantCorrectionPackage';
import { getParticipantCorrectionContext, stageParticipantCorrection } from '../previews/participantCorrectionService';
import { decideParticipantCorrection, loadCorrectionReviewView } from '../previews/participantCorrectionReview';
import { verifyPrePreviewPackageReplacementRuntime } from './verifyPrePreviewPackageReplacementRuntime';

/** Synthetic runtime only: the caller must supply a proven-owned disposable stack. No primary/hosted fallback. */
export async function verifyParticipantOwnedCorrectionsRuntime(repositoryRoot: string, identity: DisposableStackIdentity): Promise<void> {
  assertDatabaseContainerOwned(identity);
  const env = readDisposableStackEnv(repositoryRoot, identity);
  const client = createClient(env.apiUrl, env.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient(env.apiUrl, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let phase = 'schema and fixtures';
  const pass = (name: string) => console.log(`PASS: ${name}`);
  const sql = (command: string) => runDisposablePsql(identity, { command, singleTransaction: true });
  const bucket = 'project-drafts-private';
  const suffix = randomBytes(5).toString('hex');
  const publicId = `correction-runtime-${suffix}`;
  const id = randomUUID();
  const staff = { admin: randomUUID(), editor: randomUUID(), reviewer: randomUUID() };
  const data = async <T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<NonNullable<T>> => {
    const result = await query;
    if (result.error || result.data == null) throw new Error('FIXTURE_QUERY_FAILED');
    return result.data;
  };
  const rpc = async (name: string, args: Record<string, unknown>) => data(client.rpc(name, args));
  const project = () => data(client.from('projects').select('*').eq('id', id).single());
  const media = () => data(client.from('media_assets').select('*').eq('project_id', id).order('id'));
  const version = () => rpc('participant_correction_project_version', { p_project_id: id });
  const failUpload = (at: number) => {
    let count = 0;
    return new Proxy(client, { get(target, key, receiver) {
      if (key !== 'storage') return Reflect.get(target, key, receiver);
      return { from(name: string) {
        const scoped = target.storage.from(name);
        return new Proxy(scoped, { get(storage, property, storageReceiver) {
          if (property === 'upload') return (...args: Parameters<typeof scoped.upload>) => ++count === at
            ? Promise.resolve({ data: null, error: { message: 'SYNTHETIC_UPLOAD_FAILURE' } }) : scoped.upload(...args);
          return Reflect.get(storage, property, storageReceiver);
        } });
      } };
    } });
  };
  const generate = async (reissue = false) => {
    const token = randomBytes(32).toString('hex');
    const hash = correctionDigest(Buffer.from(token));
    const result = await rpc('generate_participant_preview', { p_public_id: publicId, p_admin_id: staff.admin, p_token_hash: hash, p_expires_in_seconds: 3600, p_private_bucket: bucket, p_is_correction_reissue: reissue });
    assert.equal(result.resultCode, 'SUCCESS');
    return { token, hash, id: result.previewId as string };
  };
  try {
    assert.match(sql('SELECT count(*) AS migration_count FROM supabase_migrations.schema_migrations;'), /\b51\b/);
    // Default ACLs materialize as direct grants at CREATE TABLE; SELECT alone cannot narrow them.
    const correctionTables = ['participant_correction_events', 'participant_correction_prior_revisions',
      'participant_correction_recovery_rows', 'participant_correction_submissions'];
    const tableNames = correctionTables.map((table) => "'" + table + "'").join(',');
    const expectedGrants = correctionTables.map((table) => [table, 'service_role', 'SELECT', false]);
    const directGrants = JSON.parse(sql(`COPY (
      SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname, COALESCE(r.rolname, 'PUBLIC'),
        a.privilege_type, a.is_grantable) ORDER BY c.relname, r.rolname, a.privilege_type), '[]'::jsonb)
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
      LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = 'public' AND c.relname IN (${tableNames})
        AND (a.grantee = 0 OR r.rolname IN ('anon', 'authenticated', 'service_role'))
    ) TO STDOUT;`).trim());
    assert.deepEqual(directGrants, expectedGrants);
    const effectiveGrants = JSON.parse(sql(`COPY (
      SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname, r.role, p.privilege,
        has_table_privilege(r.role, c.oid, p.privilege || ' WITH GRANT OPTION'))
        ORDER BY c.relname, r.role, p.privilege), '[]'::jsonb)
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) r(role)
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
        ('REFERENCES'), ('TRIGGER'), ('TRUNCATE'), ('MAINTAIN')) p(privilege)
      WHERE n.nspname = 'public' AND c.relname IN (${tableNames})
        AND has_table_privilege(r.role, c.oid, p.privilege)
    ) TO STDOUT;`).trim());
    assert.deepEqual(effectiveGrants, expectedGrants);
    pass('correction table direct and effective ACLs are service_role SELECT-only');
    for (const [role, userId] of Object.entries(staff)) {
      await data(client.from('admin_users').insert({ id: userId, email: `synthetic-${role}-${suffix}@example.invalid`, full_name: 'Synthetic correction verifier' }).select());
      await data(client.from('user_roles').insert({ user_id: userId, role }).select());
    }
    const taxonomy = async (table: string, name: string) => {
      await data(client.from(table).upsert({ name }, { onConflict: 'name', ignoreDuplicates: true }).select());
      return (await data(client.from(table).select('id').eq('name', name).single())).id as string;
    };
    const programId = await taxonomy('programs', 'Information Technology');
    const discipline = await taxonomy('disciplines', 'Software Engineering');
    const obsoleteDiscipline = await taxonomy('disciplines', `Synthetic Design ${suffix}`);
    const industry = await taxonomy('industry_categories', `Synthetic Industry ${suffix}`);
    phase = 'initial import and pre-preview replacement';
    const environmentKeys = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'] as const;
    const previousEnvironment = environmentKeys.map((key) => process.env[key]);
    try {
      process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.anonKey;
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
      process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
      process.env.SUPABASE_SECRET_KEY = env.serviceRoleKey;
      await verifyPrePreviewPackageReplacementRuntime(client, staff.admin, `Synthetic Design ${suffix}`, `Synthetic Industry ${suffix}`);
    } finally {
      environmentKeys.forEach((key, i) => { if (previousEnvironment[i] === undefined) delete process.env[key]; else process.env[key] = previousEnvironment[i]; });
    }
    phase = 'participant fixtures';
    await data(client.from('projects').insert({ id, public_id: publicId, title: 'Original synthetic project', summary: 'Original synthetic summary.',
      year: 2026, status: 'approved', program_id: programId, program_name: 'Information Technology', group_name: 'Synthetic team',
      team_members: ['Participant One'], poster_text_public: 'Original full poster text.', accessibility_text_public: 'Original description.',
      video_url: 'https://example.com/original-video', demo_url: 'https://example.com/original-demo', repository_url: 'https://example.com/original-code',
    }).select());
    await data(client.from('project_disciplines').insert([{ project_id: id, discipline_id: discipline }, { project_id: id, discipline_id: obsoleteDiscipline }]).select());
    await data(client.from('project_industry_categories').insert({ project_id: id, industry_category_id: industry }).select());
    for (const [role, position, bytes, fileName, mimeType] of [
      ['poster_image', null, ORIGINAL_PNG, 'original-poster.png', 'image/png'], ['poster_pdf', null, ORIGINAL_PDF, 'original-poster.pdf', 'application/pdf'],
      ['snapshot_image', 1, ORIGINAL_PNG, 'original-snapshot-1.png', 'image/png'], ['snapshot_image', 2, ORIGINAL_PNG, 'original-snapshot-2.png', 'image/png'],
    ] as const) {
      const path = `drafts/${publicId}/${role}/${fileName}`;
      const uploaded = await client.storage.from(bucket).upload(path, bytes, { upsert: false, contentType: mimeType });
      assert.equal(uploaded.error, null);
      await data(client.from('media_assets').insert({ project_id: id, asset_type: role, gallery_position: position, file_name: fileName, storage_bucket: bucket, storage_path: path,
        mime_type: mimeType, file_size_bytes: bytes.length, is_public_approved: false, alt_text_public: position ? `Original gallery ${position}` : null }).select());
    }
    const historical = await generate();
    assert.equal((await rpc('confirm_participant_preview', { p_token_hash: historical.hash })).resultCode, 'SUCCESS');
    await rpc('revoke_participant_preview', { p_public_id: publicId, p_admin_id: staff.admin });
    const historicalPreview = await data(client.from('participant_previews').select('*').eq('id', historical.id).single());
    const historicalConfirmations = await data(client.from('participant_preview_confirmations').select('*').eq('participant_preview_id', historical.id));
    const preview = await generate();
    assert.equal(await getParticipantCorrectionContext(client, preview.hash), null);
    const correction = await rpc('request_participant_preview_correction', { p_token_hash: preview.hash, p_comment: 'Synthetic project team requests metadata corrections and removal of the second gallery image and obsolete classification.' });
    assert.equal(correction.resultCode, 'SUCCESS');
    const correctionId = correction.correctionRequestId as string;
    const initial = await project(); const oldMedia = await media();
    const previewBefore = await data(client.from('participant_previews').select('*').eq('id', preview.id).single());
    const correctionBefore = await data(client.from('participant_preview_correction_requests').select('*').eq('id', correctionId).single());
    pass('51 migrations; synthetic source, old gallery and confirmed historical evidence');

    phase = 'participant staging and access controls';
    const form = await correctionForm();
    const candidate = await parseParticipantCorrectionPackage(form, publicId);
    assert.equal(await stageParticipantCorrection(failUpload(2), preview.hash, candidate), 'failed');
    assert.deepEqual(await project(), initial); assert.deepEqual(await media(), oldMedia);
    const preparing = await data(client.from('participant_correction_submissions').select('*').eq('project_id', id).single());
    assert.equal(preparing.state, 'preparing');
    assert.notEqual((await rpc('complete_participant_correction', { p_token_hash: preview.hash, p_submission_id: preparing.id, p_package_hash: candidate.hash })).resultCode, 'SUCCESS');
    assert.equal(await stageParticipantCorrection(client, preview.hash, candidate), 'submitted');
    assert.equal(await stageParticipantCorrection(client, preview.hash, candidate), 'submitted');
    assert.deepEqual(await project(), initial); assert.deepEqual(await media(), oldMedia);
    assert.equal((await data(client.from('participant_correction_submissions').select('id').eq('project_id', id))).length, 1);
    assert.equal(await getParticipantCorrectionContext(client, historical.hash), null);
    assert.equal(await getParticipantCorrectionContext(client, 'a'.repeat(64)), null);
    assert.ok((await anon.rpc('participant_correction_context', { p_token_hash: preview.hash })).error);
    assert.ok((await anon.from('participant_correction_submissions').select('*')).error);
    assert.equal((await rpc('start_participant_preview_correction_resolution', { p_public_id: publicId, p_admin_id: staff.admin })).resultCode, 'PARTICIPANT_CANDIDATE_REQUIRED');
    const view = await loadCorrectionReviewView(client, publicId, correctionId);
    assert.equal(view.available, true); assert.ok(view.candidate);
    assert.equal(view.candidate.currentMedia.length, 4); assert.equal(view.candidate.files.length, 4);
    pass('partial Storage failure remains reserved and retryable without DB application; submission and duplicate retry preserve authority; capability and legacy-action guards');

    phase = 'freeze, stale selection and concurrent review';
    const firstSubmission = view.candidate.id;
    const changedForm = await correctionForm();
    changedForm.set('workbook', new File([new Uint8Array(await correctionWorkbook({ title: 'Final synthetic participant revision' }))], 'project-details.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const finalCandidate = await parseParticipantCorrectionPackage(changedForm, publicId);
    assert.equal(await stageParticipantCorrection(client, preview.hash, finalCandidate), 'submitted');
    const current = (await loadCorrectionReviewView(client, publicId, correctionId)).candidate!;
    assert.ok(current); assert.notEqual(current.id, firstSubmission);
    const decision = { action: 'begin' as const, submissionId: current.id, packageHash: current.hash, expectedVersion: current.expectedVersion };
    assert.equal((await decideParticipantCorrection(client, publicId, staff.admin, { ...decision, action: 'return' })).success, false, 'Participant-capability submissions still require Begin review before return');
    assert.equal((await decideParticipantCorrection(client, publicId, staff.admin, { ...decision, submissionId: firstSubmission, packageHash: candidate.hash })).success, false);
    for (const role of ['editor', 'reviewer'] as const) assert.equal((await decideParticipantCorrection(client, publicId, staff[role], decision)).success, false);
    const frozen = await Promise.all([decideParticipantCorrection(client, publicId, staff.admin, decision), decideParticipantCorrection(client, publicId, staff.admin, decision)]);
    assert.equal(frozen.filter((r) => r.success).length, 1);
    assert.equal((await project()).status, 'changes_requested');
    assert.equal(await getParticipantCorrectionContext(client, preview.hash), null);
    assert.equal(await stageParticipantCorrection(client, preview.hash, finalCandidate), 'failed');
    assert.notEqual((await rpc('confirm_participant_preview', { p_token_hash: preview.hash })).resultCode, 'SUCCESS');
    const approveBefore = await client.rpc('perform_project_review_action', { p_public_id: publicId, p_admin_id: staff.admin, p_action: 'approve', p_comments: 'Synthetic premature approval attempt' });
    assert.notEqual(approveBefore.data?.status, 'approved'); assert.equal((await project()).status, 'changes_requested');
    pass('supersession, exact selection, combined staff authority, single freeze, revoked A and pre-acceptance approval block');

    phase = 'transaction rollback and recoverable retirement';
    const frozenView = (await loadCorrectionReviewView(client, publicId, correctionId)).candidate!;
    const acceptance = { action: 'accept' as const, submissionId: current.id, packageHash: current.hash, expectedVersion: frozenView.expectedVersion };
    const beforeAcceptProject = await project(); const beforeAcceptMedia = await media();
    const frozenPreview = await data(client.from('participant_previews').select('*').eq('id', preview.id).single());
    const frozenCorrection = await data(client.from('participant_preview_correction_requests').select('*').eq('id', correctionId).single());
    const oldGallery = oldMedia.find((m) => m.gallery_position === 2)!;
    assert.equal((await decideParticipantCorrection(failUpload(2), publicId, staff.admin, acceptance)).success, false);
    assert.deepEqual(await project(), beforeAcceptProject); assert.deepEqual(await media(), beforeAcceptMedia);
    assert.equal((await data(client.from('participant_correction_prior_revisions').select('submission_id').eq('submission_id', current.id))).length, 0);
    sql(`CREATE SEQUENCE public.correction_runtime_failure_count; CREATE FUNCTION public.correction_runtime_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='${oldGallery.id}'::uuid THEN PERFORM nextval('public.correction_runtime_failure_count'); RAISE EXCEPTION 'SYNTHETIC_FORCED_FAILURE'; END IF; RETURN OLD; END; $$; CREATE TRIGGER correction_runtime_failure BEFORE DELETE ON public.media_assets FOR EACH ROW EXECUTE FUNCTION public.correction_runtime_failure();`);
    try {
      assert.equal((await decideParticipantCorrection(client, publicId, staff.admin, acceptance)).success, false);
      assert.match(sql('SELECT is_called FROM public.correction_runtime_failure_count;'), /\bt\b/);
    }
    finally { sql('DROP TRIGGER correction_runtime_failure ON public.media_assets; DROP FUNCTION public.correction_runtime_failure(); DROP SEQUENCE public.correction_runtime_failure_count;'); }
    assert.deepEqual(await project(), beforeAcceptProject); assert.deepEqual(await media(), beforeAcceptMedia);
    assert.equal((await data(client.from('project_disciplines').select('*').eq('project_id', id))).length, 2);
    assert.equal((await data(client.from('project_industry_categories').select('*').eq('project_id', id))).length, 1);
    assert.equal((await data(client.from('participant_correction_prior_revisions').select('*').eq('submission_id', current.id))).length, 0);
    assert.equal((await data(client.from('participant_correction_recovery_rows').select('*').eq('submission_id', current.id))).length, 0);
    assert.equal((await data(client.from('participant_correction_submissions').select('state').eq('id', current.id).single())).state, 'frozen');
    pass('forced retirement failure rolls back metadata, media, mappings, recovery records and decision');
    const accepted = await Promise.all([decideParticipantCorrection(client, publicId, staff.admin, acceptance), decideParticipantCorrection(client, publicId, staff.admin, acceptance)]);
    assert.equal(accepted.every((r) => r.success), true);
    assert.equal((await project()).title, 'Final synthetic participant revision'); assert.equal((await project()).status, 'changes_requested');
    const newMedia = await media();
    for (const replacement of newMedia) {
      const file = finalCandidate.files.find((f) => f.role === replacement.asset_type && f.position === replacement.gallery_position)!;
      const stored = await client.storage.from(bucket).download(replacement.storage_path);
      assert.equal(stored.error, null); assert.equal(correctionDigest(Buffer.from(await stored.data!.arrayBuffer())), file.sha256);
      assert.notEqual(file.sha256, correctionDigest(replacement.asset_type === 'poster_pdf' ? ORIGINAL_PDF : ORIGINAL_PNG));
    }
    assert.equal(newMedia.length, 3); assert.equal(newMedia.some((m) => m.id === oldGallery.id), false);
    for (const old of oldMedia) { const bytes = await client.storage.from(bucket).download(old.storage_path); assert.equal(bytes.error, null); assert.equal(bytes.data?.size, old.file_size_bytes); assert.equal(correctionDigest(Buffer.from(await bytes.data!.arrayBuffer())), correctionDigest(old.asset_type === 'poster_pdf' ? ORIGINAL_PDF : ORIGINAL_PNG)); }
    const header = await data(client.from('participant_correction_prior_revisions').select('*').eq('submission_id', current.id).single());
    assert.equal(header.project_id, id); assert.equal(header.correction_request_id, correctionId); assert.equal(header.package_hash, current.hash); assert.equal(header.accepted_by, staff.admin);
    assert.deepEqual(header.project_record, beforeAcceptProject); assert.deepEqual(header.media_records, beforeAcceptMedia);
    const recovery = await data(client.from('participant_correction_recovery_rows').select('*').eq('submission_id', current.id));
    assert.deepEqual(recovery.find((r) => r.source_table === 'media_assets' && r.original_identity.id === oldGallery.id)?.row_data, oldGallery);
    assert.deepEqual(recovery.find((r) => r.source_table === 'project_disciplines' && r.original_identity.discipline_id === obsoleteDiscipline)?.row_data, { project_id: id, discipline_id: obsoleteDiscipline });
    assert.equal((await data(client.from('project_disciplines').select('*').eq('project_id', id))).length, 1);
    assert.equal((await data(client.from('project_industry_categories').select('*').eq('project_id', id))).length, 0);
    assert.ok(await data(client.from('disciplines').select('id').eq('id', obsoleteDiscipline).single()));
    assert.ok(await data(client.from('industry_categories').select('id').eq('id', industry).single()));
    assert.deepEqual(await data(client.from('participant_previews').select('*').eq('id', preview.id).single()), frozenPreview);
    assert.deepEqual(await data(client.from('participant_preview_correction_requests').select('*').eq('id', correctionId).single()), frozenCorrection);
    assert.ok(frozenPreview.snapshot); assert.deepEqual(frozenPreview.snapshot, previewBefore.snapshot); assert.deepEqual(frozenPreview.media_snapshot, previewBefore.media_snapshot);
    assert.equal(frozenCorrection.correction_comment, correctionBefore.correction_comment); assert.equal(frozenCorrection.requested_at, correctionBefore.requested_at);
    assert.deepEqual(await data(client.from('participant_previews').select('*').eq('id', historical.id).single()), historicalPreview);
    assert.deepEqual(await data(client.from('participant_preview_confirmations').select('*').eq('participant_preview_id', historical.id)), historicalConfirmations);
    assert.equal((await decideParticipantCorrection(client, publicId, staff.admin, acceptance)).success, true);
    assert.deepEqual(await data(client.from('participant_correction_recovery_rows').select('*').eq('submission_id', current.id)), recovery);
    assert.equal((await data(client.from('participant_correction_events').select('*').eq('submission_id', current.id).eq('event', 'staff_accepted_revision'))).length, 1);
    pass('gallery and mapping removal, exact bound recovery, old Storage and evidence preservation, concurrent/idempotent acceptance');

    phase = 'normal reapproval, corrected preview and reconfirmation';
    const approval = await rpc('perform_project_review_action', { p_public_id: publicId, p_admin_id: staff.admin, p_action: 'approve', p_comments: 'Synthetic normal review after exact participant revision acceptance' });
    assert.equal(approval.status, 'approved');
    const previewB = await generate(true);
    const snapshotB = await data(client.from('participant_previews').select('*').eq('id', previewB.id).single());
    assert.equal(snapshotB.snapshot.title, 'Final synthetic participant revision'); assert.equal(snapshotB.media_snapshot.length, 3);
    assert.equal(snapshotB.snapshot.demoUrl, 'https://example.com/demo');
    assert.equal((await data(client.from('participant_preview_confirmations').select('*').eq('participant_preview_id', previewB.id))).length, 0);
    assert.equal((await rpc('confirm_participant_preview', { p_token_hash: previewB.hash })).resultCode, 'SUCCESS');
    assert.equal((await project()).status, 'approved');
    const readiness = await rpc('get_project_publication_readiness', { p_public_id: publicId, p_admin_id: staff.admin, p_private_bucket: bucket });
    assert.equal(readiness.resultCode, 'READY'); assert.equal(readiness.ready, true);
    await data(client.from('projects').update({ demo_url: 'https://example.com/changed-after-confirmation' }).eq('id', id).select());
    assert.equal((await rpc('get_project_publication_readiness', { p_public_id: publicId, p_admin_id: staff.admin, p_private_bucket: bucket })).resultCode, 'PROJECT_SNAPSHOT_STALE');
    await data(client.from('projects').update({ demo_url: finalCandidate.metadata.demoUrl }).eq('id', id).select());
    pass('normal reapproval, corrected immutable Preview B, fresh confirmation and readiness without publication; post-confirmation link mutation is stale');
    await rpc('revoke_participant_preview', { p_public_id: publicId, p_admin_id: staff.admin });
    assert.equal(await getParticipantCorrectionContext(client, previewB.hash), null);
    pass('synthetic capabilities revoked; no raw token persisted');

    phase = 'concurrent submissions, quotas and fail-closed revision selection';
    const quotaPreview = await generate();
    const quotaCorrection = await rpc('request_participant_preview_correction', { p_token_hash: quotaPreview.hash, p_comment: 'Synthetic quota and concurrency correction.' });
    const quotaId = quotaCorrection.correctionRequestId as string;
    const makeCandidate = async (title: string) => {
      const form = await correctionForm();
      form.set('workbook', new File([new Uint8Array(await correctionWorkbook({ title }))], 'project-details.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      return parseParticipantCorrectionPackage(form, publicId);
    };
    const same = await makeCandidate('Concurrent identical candidate');
    assert.deepEqual(await Promise.all([stageParticipantCorrection(client, quotaPreview.hash, same), stageParticipantCorrection(client, quotaPreview.hash, same)]), ['submitted', 'submitted']);
    assert.equal((await data(client.from('participant_correction_submissions').select('id').eq('correction_request_id', quotaId))).length, 1);
    const two = await makeCandidate('Concurrent candidate two'); const three = await makeCandidate('Concurrent candidate three');
    await Promise.all([stageParticipantCorrection(client, quotaPreview.hash, two), stageParticipantCorrection(client, quotaPreview.hash, three)]);
    const quotaRows = await data(client.from('participant_correction_submissions').select('*').eq('correction_request_id', quotaId));
    assert.equal(quotaRows.length, 3); assert.equal(quotaRows.filter((s) => s.state === 'submitted').length, 1);
    assert.equal(await stageParticipantCorrection(client, quotaPreview.hash, await makeCandidate('Beyond submission allowance')), 'limit');
    const quotaView = (await loadCorrectionReviewView(client, publicId, quotaId)).candidate!;
    assert.ok(quotaView);
    const beginQuota = { action: 'begin' as const, submissionId: quotaView.id, packageHash: quotaView.hash, expectedVersion: quotaView.expectedVersion };
    const unrelatedId = randomUUID(); const unrelatedPublicId = `unrelated-${suffix}`;
    await data(client.from('projects').insert({ id: unrelatedId, public_id: unrelatedPublicId, title: 'Unrelated synthetic project', year: 2026, status: 'approved' }).select());
    const unrelatedBefore = await data(client.from('projects').select('*').eq('id', unrelatedId).single());
    assert.equal((await decideParticipantCorrection(client, unrelatedPublicId, staff.admin, beginQuota)).success, false);
    assert.equal((await rpc('review_participant_correction', { p_public_id: unrelatedPublicId, p_admin_id: staff.admin, p_submission_id: quotaView.id, p_package_hash: quotaView.hash, p_expected_version: quotaView.expectedVersion, p_action: 'begin' })).resultCode, 'UNAVAILABLE');
    assert.deepEqual(await data(client.from('projects').select('*').eq('id', unrelatedId).single()), unrelatedBefore);
    await data(client.from('projects').update({ internal_staff_notes: 'Synthetic governance note changed after evidence was loaded.' }).eq('id', id).select());
    assert.equal((await decideParticipantCorrection(client, publicId, staff.admin, beginQuota)).code, 'STALE_REVISION');
    const unsafeMedia = (await media())[0];
    await data(client.from('media_assets').update({ is_public_approved: true, public_url: 'https://example.invalid/synthetic-public', public_storage_bucket: 'project-public-assets', public_storage_path: 'synthetic-public' }).eq('id', unsafeMedia.id).select());
    const unsafeVersion = await version();
    assert.equal((await rpc('review_participant_correction', { p_public_id: publicId, p_admin_id: staff.admin, p_submission_id: quotaView.id, p_package_hash: quotaView.hash, p_expected_version: unsafeVersion, p_action: 'begin' })).resultCode, 'UNSAFE_REVISION');
    await data(client.from('media_assets').update({ is_public_approved: false, public_url: null, public_storage_bucket: null, public_storage_path: null }).eq('id', unsafeMedia.id).select());
    assert.equal((await project()).status, 'approved');
    assert.equal((await decideParticipantCorrection(client, publicId, staff.admin, { ...beginQuota, expectedVersion: await version() })).success, true);
    pass('duplicate and competing uploads, durable three-package quota, cross-project denial, stale evidence and unexpectedly public media rejection');

    phase = 'return and next correction cycle';
    const beforeReturn = await project(); const mediaBeforeReturn = await media();
    const frozenQuota = (await loadCorrectionReviewView(client, publicId, quotaId)).candidate!;
    const returnDecision = { action: 'return' as const, submissionId: frozenQuota.id, packageHash: frozenQuota.hash, expectedVersion: frozenQuota.expectedVersion };
    assert.equal((await decideParticipantCorrection(client, publicId, staff.admin, returnDecision)).success, true);
    assert.deepEqual(await project(), beforeReturn); assert.deepEqual(await media(), mediaBeforeReturn);
    assert.equal((await decideParticipantCorrection(client, publicId, staff.admin, { ...returnDecision, action: 'accept' })).success, false);
    assert.equal((await rpc('perform_project_review_action', { p_public_id: publicId, p_admin_id: staff.admin, p_action: 'approve', p_comments: 'Synthetic review of retained draft after return' })).status, 'approved');
    const racePreview = await generate(true);
    const raceCorrection = await rpc('request_participant_preview_correction', { p_token_hash: racePreview.hash, p_comment: 'Synthetic new cycle after return.' });
    const raceId = raceCorrection.correctionRequestId as string;
    const raceFirst = await makeCandidate('Race first candidate'); const raceSecond = await makeCandidate('Race second candidate');
    assert.equal(await stageParticipantCorrection(client, racePreview.hash, raceFirst), 'submitted');
    const raceView = (await loadCorrectionReviewView(client, publicId, raceId)).candidate!;
    await Promise.all([
      decideParticipantCorrection(client, publicId, staff.admin, { action: 'begin', submissionId: raceView.id, packageHash: raceView.hash, expectedVersion: raceView.expectedVersion }),
      stageParticipantCorrection(client, racePreview.hash, raceSecond),
    ]);
    let raceCurrent = (await loadCorrectionReviewView(client, publicId, raceId)).candidate!;
    if (raceCurrent.state === 'submitted') {
      assert.equal((await decideParticipantCorrection(client, publicId, staff.admin, { action: 'begin', submissionId: raceCurrent.id, packageHash: raceCurrent.hash, expectedVersion: raceCurrent.expectedVersion })).success, true);
      raceCurrent = (await loadCorrectionReviewView(client, publicId, raceId)).candidate!;
    }
    const raceRows = await data(client.from('participant_correction_submissions').select('*').eq('correction_request_id', raceId));
    assert.equal(raceRows.filter((s) => s.frozen_at !== null).length, 1); assert.equal(raceCurrent.state, 'frozen');
    assert.equal(await getParticipantCorrectionContext(client, racePreview.hash), null);
    assert.equal((await decideParticipantCorrection(client, publicId, staff.admin, { action: 'return', submissionId: raceCurrent.id, packageHash: raceCurrent.hash, expectedVersion: raceCurrent.expectedVersion })).success, true);
    const receiptState = await project();
    assert.equal((await decideParticipantCorrection(client, publicId, staff.admin, acceptance)).success, true);
    assert.deepEqual(await project(), receiptState);
    pass('return preserves content and permits a new correction cycle; begin/upload race freezes exactly one candidate; old acceptance replay never reapplies');
  } catch (error) {
    const location = error instanceof Error ? error.stack?.match(/verifyParticipantOwnedCorrectionsRuntime\.ts:\d+:\d+/)?.[0] : undefined;
    throw new Error(`PARTICIPANT_CORRECTION_RUNTIME_FAILED: ${phase}; ${location ?? 'query'}`);
  }
}
