import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthenticatedAdminContext } from '../auth/authTypes';
import { analyzeBrowserImportServer } from '../import/parseBrowserImportPreview';
import { generateUploadKey } from '../import/browserSelection';
import { stageBrowserImportMetadata } from '../import/stageBrowserImportMetadata';
import { stageBrowserImportMedia } from '../import/stageBrowserImportMedia';
import { correctionForm, correctionWorkbook, ORIGINAL_PDF, ORIGINAL_PNG } from '../previews/participantCorrectionFixtures';
import { correctionDigest, parseParticipantCorrectionPackage } from '../previews/participantCorrectionPackage';
import { stagePrePreviewReplacement } from '../previews/participantCorrectionService';
import { decideParticipantCorrection, loadCorrectionReviewView } from '../previews/participantCorrectionReview';

/** Called only by the owned disposable correction runtime; uses real initial import services. */
export async function verifyPrePreviewPackageReplacementRuntime(client: SupabaseClient, adminId: string, obsoleteDiscipline: string, industry: string) {
  const publicId = `initial-review-${randomBytes(5).toString('hex')}`;
  const data = async <T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<NonNullable<T>> => {
    const result = await query;
    if (result.error || result.data == null) throw new Error('INITIAL_REVIEW_QUERY_FAILED');
    return result.data;
  };
  const rpc = (name: string, args: Record<string, unknown>) => data(client.rpc(name, args));
  const auth: AuthenticatedAdminContext = { adminUserId: adminId, authUserId: adminId, email: 'synthetic@example.invalid', fullName: 'Synthetic staff', roles: ['admin'], permissions: ['projects.edit', 'projects.review'] };
  const workbookBytes = await correctionWorkbook({ title: 'Initial project-team title', discipline: `Software Engineering, ${obsoleteDiscipline}`, industry, snapshot2AltText: 'Original second supporting image.' });
  const files = [
    { name: 'project-details.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: workbookBytes },
    { name: 'poster.png', mime: 'image/png', content: ORIGINAL_PNG },
    { name: 'poster.pdf', mime: 'application/pdf', content: ORIGINAL_PDF },
    { name: 'snapshot-1.png', mime: 'image/png', content: ORIGINAL_PNG },
    { name: 'snapshot-2.png', mime: 'image/png', content: ORIGINAL_PNG },
  ];
  const manifest = { selectedRootName: publicId, fileCount: files.length, declaredTotalBytes: files.reduce((n, f) => n + f.content.length, 0), ignoredSystemFilesCount: 0,
    descriptors: files.map((f) => ({ uploadKey: generateUploadKey(`${publicId}/${f.name}`), originalPath: `${publicId}/${f.name}`, fileSizeBytes: f.content.length, browserMimeType: f.mime })) };
  const reference = new ExcelJS.Workbook(); const refSheet = reference.addWorksheet('REFERENCE');
  refSheet.addRow(['Public ID', 'Official Project Title']); refSheet.addRow([publicId, 'Initial project-team title']);
  const analysis = await analyzeBrowserImportServer(manifest, new Map([[manifest.descriptors[0].uploadKey, workbookBytes]]), {
    referenceFileBuffer: Buffer.from(await reference.xlsx.writeBuffer()), mapping: { worksheet: 'REFERENCE',
      matchMappings: [{ canonicalField: 'publicId', referenceColumn: 'Public ID' }], comparisonMappings: [{ canonicalField: 'title', referenceColumn: 'Official Project Title' }], reconciliationContractVersion: 'admin-reference-reconciliation-v1' },
  });
  assert.notEqual(analysis.packages[0].status, 'invalid', 'Initial complete package must pass import parsing');
  const staged = await stageBrowserImportMetadata({ authContext: auth, serverAnalysis: analysis, intent: {
    version: 1, previewFingerprint: analysis.preview.batch.previewFingerprint, selectedRootName: publicId,
    fileCount: files.length, declaredTotalBytes: manifest.declaredTotalBytes, selectedPackagePaths: [publicId], acknowledgedWarningPackagePaths: [publicId], adminReference: analysis.preview.batch.adminReference,
  } });
  assert.equal(staged.success, true, 'Initial metadata import succeeds'); if (!staged.success) return;
  const intent = await data(client.from('browser_import_commits').select('intent_hash').eq('batch_id', staged.batchId).single());
  const mediaStage = await stageBrowserImportMedia({ authContext: auth, batchId: staged.batchId, metadataIntentHash: intent.intent_hash,
    files: files.slice(1).map((f, i) => ({ packagePath: publicId, projectPublicId: publicId, assetType: i === 0 ? 'poster_image' : i === 1 ? 'poster_pdf' : 'snapshot_image',
      fileName: f.name, fileSizeBytes: f.content.length, canonicalMimeType: f.mime, galleryPosition: i < 2 ? null : i - 1,
      snapshotAltText: i < 2 ? null : i === 2 ? 'Prototype on a bench.' : 'Original second supporting image.', content: f.content })),
  });
  assert.equal(mediaStage.success, true, 'Initial complete media import succeeds');
  const project = () => data(client.from('projects').select('*').eq('public_id', publicId).single());
  const initial = await project(); assert.equal(initial.status, 'draft');
  const media = () => data(client.from('media_assets').select('*').eq('project_id', initial.id).order('id'));
  const context = () => rpc('pre_preview_package_context', { p_public_id: publicId, p_admin_id: adminId });
  assert.equal((await context()).resultCode, 'SUCCESS');
  assert.equal((await rpc('submit_import_projects_for_review', { p_batch_id: staged.batchId, p_project_public_ids: [publicId], p_admin_id: adminId, p_comments: 'Initial technical checks completed.' })).resultCode, 'SUCCESS');
  assert.equal((await project()).status, 'submitted'); assert.equal((await context()).resultCode, 'SUCCESS');
  assert.equal((await rpc('perform_project_review_action', { p_public_id: publicId, p_admin_id: adminId, p_action: 'request_changes', p_comments: 'Project team must correct the submitted content before approval.' })).status, 'changes_requested');
  assert.equal((await data(client.from('participant_previews').select('id').eq('project_id', initial.id))).length, 0);

  // Model a legacy package-specific blocker identified after initial import. Its
  // actual source condition (missing description) is corrected by the new workbook.
  const oldGallery = (await media()).find((m) => m.gallery_position === 1)!;
  await data(client.from('media_assets').update({ alt_text_public: null }).eq('id', oldGallery.id).select());
  const flags = await data(client.from('validation_flags').insert([
    { project_id: initial.id, rule_code: 'METADATA_MISSING_SNAPSHOT_ALT_TEXT', field_name: 'snapshotAltText', message: 'Superseded package lacks its image description.', severity: 'error', resolved: false },
    { project_id: initial.id, rule_code: 'STAFF_GOVERNANCE_REVIEW', field_name: null, message: 'Governance finding requiring separate staff review.', severity: 'error', resolved: false },
    { project_id: initial.id, rule_code: 'METADATA_MISSING_TITLE', field_name: 'unrecognizedField', message: 'Mismatched rule identity must remain unresolved.', severity: 'warning', resolved: false },
    { project_id: initial.id, rule_code: 'HISTORICAL_CHECK', field_name: null, message: 'Resolved historical evidence.', severity: 'info', resolved: true },
  ]).select());
  const blockingCount = async () => Number((await rpc('get_bulk_project_review_evidence', { p_project_ids: [initial.id] }))[0].unresolved_error_count);
  assert.equal(await blockingCount(), 2, 'Old package and governance errors both block normal review readiness');
  const before = await project(); const oldMedia = await media();
  const candidate = await parseParticipantCorrectionPackage(await correctionForm(), publicId);
  assert.equal(await stagePrePreviewReplacement(client, publicId, adminId, candidate), 'submitted');
  assert.deepEqual(await project(), before); assert.deepEqual(await media(), oldMedia);
  const view = (await loadCorrectionReviewView(client, publicId, null, true)).candidate!; assert.ok(view);
  assert.equal(view.validationFlags.filter((f) => f.willResolve).length, 1);
  assert.ok(view.fields.some((f) => f.name === 'title' && f.changed && f.proposed === candidate.metadata.title));
  const selection = { submissionId: view.id, packageHash: view.hash, expectedVersion: view.expectedVersion };
  assert.equal((await decideParticipantCorrection(client, publicId, adminId, { ...selection, packageHash: '0'.repeat(64), action: 'begin' })).success, false);
  assert.equal((await decideParticipantCorrection(client, publicId, adminId, { ...selection, action: 'begin' })).success, true);
  assert.deepEqual(await project(), before); assert.deepEqual(await media(), oldMedia);
  assert.equal(await stagePrePreviewReplacement(client, publicId, adminId, candidate), 'failed');
  const premature = await client.rpc('perform_project_review_action', { p_public_id: publicId, p_admin_id: adminId, p_action: 'approve', p_comments: 'Must not approve a frozen package.' });
  assert.notEqual(premature.data?.status, 'approved');
  assert.equal((await decideParticipantCorrection(client, publicId, adminId, { ...selection, action: 'accept' })).success, true);
  const accepted = await project(); assert.equal(accepted.status, 'changes_requested');
  for (const [field, column] of Object.entries({ title: 'title', summary: 'summary', background: 'background', solution: 'solution', teamMembers: 'team_members', posterText: 'poster_text_public', accessibilityText: 'accessibility_text_public', demoUrl: 'demo_url', repositoryUrl: 'repository_url', videoUrl: 'video_url', layoutConfig: 'layout_config' })) {
    assert.deepEqual(accepted[column], candidate.metadata[field as keyof typeof candidate.metadata]);
  }
  const recovery = await data(client.from('participant_correction_prior_revisions').select('*').eq('submission_id', view.id).single());
  assert.deepEqual(recovery.project_record, before); assert.deepEqual(recovery.media_records, oldMedia);
  assert.ok(recovery.validation_records.some((f: { id: string }) => f.id === flags[0].id));
  const evidence = await data(client.from('participant_correction_recovery_rows').select('*').eq('submission_id', view.id));
  assert.deepEqual(evidence.find((r) => r.source_table === 'validation_flags')?.row_data, flags[0]);
  const afterFlags = await data(client.from('validation_flags').select('*').eq('project_id', initial.id));
  assert.equal(afterFlags.find((f) => f.id === flags[0].id)?.resolved, true);
  assert.equal(afterFlags.find((f) => f.id === flags[0].id)?.resolved_by, adminId);
  for (const flag of flags.slice(1)) assert.deepEqual(afterFlags.find((f) => f.id === flag.id), flag);
  assert.equal(await blockingCount(), 1, 'Only the corrected package error resolves; governance still blocks review readiness');
  assert.equal((await media()).length, 3);
  for (const m of await media()) {
    const replacement = candidate.files.find((f) => f.role === m.asset_type && f.position === m.gallery_position)!;
    const bytes = await data(client.storage.from('project-drafts-private').download(m.storage_path));
    assert.equal(correctionDigest(Buffer.from(await bytes.arrayBuffer())), replacement.sha256); assert.equal(m.alt_text_public, replacement.altText);
  }
  for (const m of oldMedia) assert.equal((await data(client.storage.from(m.storage_bucket).download(m.storage_path))).size, m.file_size_bytes);
  assert.equal((await data(client.from('project_disciplines').select('*').eq('project_id', initial.id))).length, 1);
  assert.equal((await data(client.from('project_industry_categories').select('*').eq('project_id', initial.id))).length, 0);
  assert.ok(evidence.some((r) => r.source_table === 'project_disciplines')); assert.ok(evidence.some((r) => r.source_table === 'project_industry_categories'));
  assert.equal((await decideParticipantCorrection(client, publicId, adminId, { ...selection, action: 'accept' })).success, true);
  assert.deepEqual(await project(), accepted);
  const submission = await data(client.from('participant_correction_submissions').select('*').eq('id', view.id).single());
  assert.equal(submission.source, 'staff_pre_preview'); assert.equal(submission.transported_by, adminId); assert.equal(submission.participant_preview_id, null);
  assert.equal((await data(client.from('participant_correction_events').select('*').eq('submission_id', view.id).eq('event', 'staff_transported_package'))).length, 1);
  // Separate explicit staff resolution of the synthetic governance flag; package acceptance left it untouched.
  await data(client.from('validation_flags').update({ resolved: true, resolved_by: adminId, resolved_at: new Date().toISOString() }).eq('id', flags[1].id).select());
  assert.equal(await blockingCount(), 0, 'Separate staff governance review removes the remaining blocker');
  assert.equal((await rpc('perform_project_review_action', { p_public_id: publicId, p_admin_id: adminId, p_action: 'approve', p_comments: 'Normal review completed after project-team package acceptance and separate governance review.' })).status, 'approved');
  const tokenHash = correctionDigest(randomBytes(32));
  assert.equal((await rpc('generate_participant_preview', { p_public_id: publicId, p_admin_id: adminId, p_token_hash: tokenHash, p_expires_in_seconds: 3600, p_private_bucket: 'project-drafts-private', p_is_correction_reissue: false })).resultCode, 'SUCCESS');
  assert.equal((await context()).resultCode, 'UNAVAILABLE');
  assert.equal(await stagePrePreviewReplacement(client, publicId, adminId, candidate), 'failed');
  await rpc('revoke_participant_preview', { p_public_id: publicId, p_admin_id: adminId });
  console.log('PASS: real initial complete import → request changes → immutable staff-transported package comparison → recoverable exact acceptance → separate review/approval → first participant preview; package flag resolution preserves governance/history');
}
