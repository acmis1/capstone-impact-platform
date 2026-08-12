import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import { SupabaseParticipantPreviewRepositoryCore } from '../repositories/SupabaseParticipantPreviewRepositoryCore';
import { preparePublicationPlan } from '../projects/publicationPlanService';
import { getPermissionsForRoles } from '../auth/permissions';
import { compilePublicationCandidateFeed } from '../feed/compilePublicFeed';
import { serializePublicFeedArtifact } from '../feed/serializePublicFeedArtifact';

const BUCKET = 'project-drafts-private';
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export async function runPublicationPreparationRuntimeVerification(): Promise<boolean> {
  console.log('=== Publication Preparation Local Supabase Runtime Verification ===');
  const root = path.resolve(__dirname, '../../../..');
  const env = parseSupabaseCliEnv(execSync(`"${path.resolve(root, 'node_modules/.bin/supabase')}" status --workdir "${path.resolve(root, 'infra')}" -o env`, { cwd: root, encoding: 'utf8' }));
  if (!env.API_URL || !env.SERVICE_ROLE_KEY) throw new Error('Local Supabase service credentials unavailable.');
  const db = createClient(env.API_URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const projects = new SupabaseProjectRepositoryCore(db);
  const previews = new SupabaseParticipantPreviewRepositoryCore(db);
  const prefix = `publication-plan-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const owned: string[] = [];
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  const list = async (bucket: string, prefixPath = ''): Promise<string> => { const result = await db.storage.from(bucket).list(prefixPath, { limit: 1000 }); if (result.error) throw result.error; const nested = await Promise.all((result.data ?? []).map(async (item) => item.id ? item : JSON.parse(await list(bucket, `${prefixPath}${prefixPath ? '/' : ''}${item.name}`)))); return JSON.stringify({ prefixPath, items: nested }); };
  const baseline = { feeds: await list('public-feeds'), assets: await list('project-public-assets'), snapshots: (await db.from('published_snapshots').select('id', { count: 'exact', head: true })).count ?? 0 };
  const initialPublishedIds = ((await db.from('projects').select('public_id').eq('status', 'published')).data ?? []).map((row) => row.public_id);
  const users = (await db.from('user_roles').select('user_id, role')).data ?? [];
  const adminId = String(users.find((row) => row.role === 'admin')?.user_id ?? '');
  assert(adminId, 'Admin fixture unavailable.');
  async function create(tag: string, status: 'approved' | 'published' = 'approved') {
    const publicId = `${prefix}-${tag}`;
    const result = await db.from('projects').insert({ public_id: publicId, title: tag, summary: 'Summary', background: 'Background', solution: 'Solution', year: 2026, program_name: 'Software Engineering', study_program: 'Bachelor of Software Engineering', discipline: 'Software Engineering', industry: 'Technology', industry_partner: 'Partner', academic_supervisor: 'Supervisor', group_name: 'Group', team_members: ['Synthetic'], poster_text_public: 'Poster', accessibility_text_public: 'Accessible', status }).select('id, public_id').single();
    if (result.error || !result.data) throw new Error(`Fixture ${tag} failed: ${result.error?.message}`);
    owned.push(result.data.id); return result.data;
  }
  async function ready(tag: string) {
    const project = await create(tag); const token = hash(crypto.randomUUID());
    const preview = await previews.generatePreview({ publicId: project.public_id, adminId, tokenHash: token, privateBucket: BUCKET });
    const confirmation = await previews.confirmPreview(token);
    assert(confirmation, 'Confirmation failed');
    return { project, preview, confirmation: confirmation! };
  }
  const plan = (publicId: string, role: 'admin' | 'reviewer' | 'editor' = 'admin') => preparePublicationPlan(getPermissionsForRoles([role]), publicId, { getReadiness: () => previews.getPublicationReadiness({ publicId, adminId, privateBucket: BUCKET }), listProjects: () => projects.listProjects() });
  let primaryFailure: unknown = null;
  let cleanupFailure: unknown = null;
  try {
    console.log('Scenario 1: READY target'); const published = await create('baseline', 'published'); const target = await ready('target'); await create('unrelated'); const first = await plan(target.project.public_id); assert(first.resultCode === 'READY_TO_STAGE' && first.publicId === target.project.public_id, 'READY plan failed'); console.log('PASS: Scenario 1');
    console.log('Scenario 2: candidate membership'); const expectedFeed = compilePublicationCandidateFeed(await projects.listProjects(), target.project.public_id); const expected = serializePublicFeedArtifact(expectedFeed); const expectedIds = [...new Set([...initialPublishedIds, published.public_id, target.project.public_id])].sort(); assert(JSON.stringify(expectedFeed.map((record) => record.publicId).sort()) === JSON.stringify(expectedIds) && !expectedFeed.some((record) => record.publicId === `${prefix}-unrelated`) && first.resultCode === 'READY_TO_STAGE' && first.recordCount === expectedFeed.length && first.feedHash === expected.feedHash, 'Candidate membership/hash mismatch'); console.log('PASS: Scenario 2');
    console.log('Scenario 3: confirmation evidence'); const authoritativeConfirmation = await db.from('participant_preview_confirmations').select('confirmed_at').eq('participant_preview_id', target.preview.previewId).single(); const evidenceMatches = !authoritativeConfirmation.error && first.resultCode === 'READY_TO_STAGE' && first.confirmedPreviewId === target.preview.previewId && first.confirmedAt && Date.parse(first.confirmedAt) === Date.parse(authoritativeConfirmation.data.confirmed_at); assert(evidenceMatches, `Confirmation evidence mismatch: plan=${first.resultCode === 'READY_TO_STAGE' ? `${first.confirmedPreviewId}/${first.confirmedAt}` : first.resultCode}, authoritative=${authoritativeConfirmation.data?.confirmed_at}`); console.log('PASS: Scenario 3');
    console.log('Scenario 4: deterministic artifact'); assert(expected.content === serializePublicFeedArtifact(compilePublicationCandidateFeed(await projects.listProjects(), target.project.public_id)).content, 'Artifact bytes unstable'); console.log('PASS: Scenario 4');
    console.log('Scenario 5: reviewer blocked'); assert((await plan(target.project.public_id, 'reviewer')).resultCode === 'PERMISSION_DENIED', 'Reviewer permitted'); console.log('PASS: Scenario 5');
    console.log('Scenario 6: editor blocked'); assert((await plan(target.project.public_id, 'editor')).resultCode === 'PERMISSION_DENIED', 'Editor permitted'); console.log('PASS: Scenario 6');
    console.log('Scenario 7: unconfirmed target'); const unconfirmed = await create('unconfirmed'); await previews.generatePreview({ publicId: unconfirmed.public_id, adminId, tokenHash: hash(crypto.randomUUID()), privateBucket: BUCKET }); const p7 = await plan(unconfirmed.public_id); assert(p7.resultCode === 'NOT_READY' && p7.readinessCode === 'PREVIEW_NOT_CONFIRMED', 'Unconfirmed readiness incorrect'); console.log('PASS: Scenario 7');
    console.log('Scenario 8: correction unresolved'); const correction = await create('correction'); const correctionToken = hash(crypto.randomUUID()); await previews.generatePreview({ publicId: correction.public_id, adminId, tokenHash: correctionToken, privateBucket: BUCKET }); await previews.requestCorrection(correctionToken, 'Synthetic correction'); const p8open = await plan(correction.public_id); assert(p8open.resultCode === 'NOT_READY' && p8open.readinessCode === 'CORRECTION_UNRESOLVED', 'Open correction readiness incorrect'); await previews.startCorrectionResolution({ publicId: correction.public_id, adminId }); const p8progress = await plan(correction.public_id); assert(p8progress.resultCode === 'NOT_READY' && (p8progress.readinessCode === 'CORRECTION_UNRESOLVED' || p8progress.readinessCode === 'INVALID_PROJECT_STATE'), 'In-progress correction readiness incorrect'); console.log('PASS: Scenario 8');
    console.log('Scenario 9: metadata drift'); const metadata = await ready('metadata'); await db.from('projects').update({ title: 'Drifted' }).eq('id', metadata.project.id); const p9 = await plan(metadata.project.public_id); assert(p9.resultCode === 'NOT_READY' && p9.readinessCode === 'PROJECT_SNAPSHOT_STALE', 'Metadata drift readiness incorrect'); console.log('PASS: Scenario 9');
    console.log('Scenario 10: private-media drift'); const media = await ready('media'); const insertMedia = await db.from('media_assets').insert({ project_id: media.project.id, asset_type: 'poster', file_name: 'extra.png', storage_bucket: BUCKET, storage_path: `${prefix}/media/extra.png`, public_url: null, mime_type: 'image/png', file_size_bytes: 1, is_public_approved: false }); assert(!insertMedia.error, `Media fixture failed: ${insertMedia.error?.message}`); const p10 = await plan(media.project.public_id); assert(p10.resultCode === 'NOT_READY' && p10.readinessCode === 'MEDIA_SNAPSHOT_STALE', 'Media drift readiness incorrect'); console.log('PASS: Scenario 10');
    console.log('Scenario 11: revoked preview freshness'); const revoked = await ready('revoked'); await previews.revokePreview({ publicId: revoked.project.public_id, adminId }); const p11 = await plan(revoked.project.public_id); assert(p11.resultCode === 'NOT_READY' && p11.readinessCode === 'NO_ACTIVE_PREVIEW', 'Revoked readiness incorrect'); console.log('PASS: Scenario 11');
    console.log('Scenario 12: project state drift'); const state = await ready('state'); await db.from('projects').update({ status: 'changes_requested' }).eq('id', state.project.id); const p12 = await plan(state.project.public_id); assert(p12.resultCode === 'NOT_READY' && p12.readinessCode === 'INVALID_PROJECT_STATE', 'State drift readiness incorrect'); console.log('PASS: Scenario 12');
    console.log('Scenario 13: sequential repeat'); const repeat = await ready('repeat'); const relevantIds = [published.id, target.project.id, repeat.project.id]; const beforePlan = JSON.stringify(await Promise.all([db.from('projects').select('id,status,updated_at').in('id', relevantIds), db.from('published_snapshots').select('id'), db.from('approval_records').select('id,project_id').in('project_id', relevantIds), db.from('media_assets').select('id,project_id,storage_bucket,storage_path,public_url,is_public_approved').in('project_id', relevantIds), db.from('participant_previews').select('id,project_id,status').in('project_id', relevantIds)])); const [one, two] = [await plan(repeat.project.public_id), await plan(repeat.project.public_id)]; assert(JSON.stringify(one) === JSON.stringify(two), 'Repeat plan changed'); console.log('PASS: Scenario 13');
    console.log('Scenario 14: concurrent requests'); const concurrent = await Promise.all([plan(repeat.project.public_id), plan(repeat.project.public_id)]); assert(JSON.stringify(concurrent[0]) === JSON.stringify(concurrent[1]), 'Concurrent plan changed'); console.log('PASS: Scenario 14');
    console.log('Scenario 15: zero database/publication side effects'); const afterPlan = JSON.stringify(await Promise.all([db.from('projects').select('id,status,updated_at').in('id', relevantIds), db.from('published_snapshots').select('id'), db.from('approval_records').select('id,project_id').in('project_id', relevantIds), db.from('media_assets').select('id,project_id,storage_bucket,storage_path,public_url,is_public_approved').in('project_id', relevantIds), db.from('participant_previews').select('id,project_id,status').in('project_id', relevantIds)])); assert(afterPlan === beforePlan && (await db.from('published_snapshots').select('id', { count: 'exact', head: true })).count === baseline.snapshots, 'Plan mutated database state'); console.log('PASS: Scenario 15');
    console.log('Scenario 16: zero public-storage side effects'); assert(await list('public-feeds') === baseline.feeds && await list('project-public-assets') === baseline.assets, 'Public storage changed'); console.log('PASS: Scenario 16');
  } catch (error) {
    primaryFailure = error;
    console.error('PRIMARY FAILURE:', error instanceof Error ? error.message : String(error));
  } finally {
    console.log('Scenario 17: independent cleanup');
    try {
      const previewsBeforeDelete = ((await db.from('participant_previews').select('id').in('project_id', owned)).data ?? []).map((row) => row.id);
      if (previewsBeforeDelete.length) { await db.from('participant_preview_correction_requests').delete().in('participant_preview_id', previewsBeforeDelete); await db.from('participant_preview_confirmations').delete().in('participant_preview_id', previewsBeforeDelete); }
      for (const table of ['project_disciplines', 'project_industry_categories', 'validation_flags', 'approval_records', 'media_assets', 'participant_previews']) { const removed = await db.from(table).delete().in('project_id', owned); if (removed.error) throw removed.error; }
      if (owned.length) { const result = await db.from('projects').delete().in('id', owned); if (result.error) throw result.error; }
      const checks: Array<[string, string, string[]]> = [['projects', 'id', owned], ['participant_previews', 'project_id', owned], ['media_assets', 'project_id', owned], ['project_disciplines', 'project_id', owned], ['project_industry_categories', 'project_id', owned], ['validation_flags', 'project_id', owned], ['approval_records', 'project_id', owned], ['participant_preview_confirmations', 'participant_preview_id', previewsBeforeDelete], ['participant_preview_correction_requests', 'participant_preview_id', previewsBeforeDelete]];
      for (const [table, column, ids] of checks) { if (ids.length) { const residue = await db.from(table).select(column, { count: 'exact', head: true }).in(column, ids); assert(!residue.error && (residue.count ?? 0) === 0, `${table} cleanup residue remains`); } }
      const residue = await db.from('projects').select('id', { count: 'exact', head: true }).like('public_id', `${prefix}%`); assert((residue.count ?? 0) === 0 && (await db.from('published_snapshots').select('id', { count: 'exact', head: true })).count === baseline.snapshots, 'Fixture cleanup residue remains');
      assert(await list('public-feeds') === baseline.feeds && await list('project-public-assets') === baseline.assets, 'Cleanup public storage mismatch'); console.log('PASS: Scenario 17');
    } catch (error) { cleanupFailure = error; console.error('CLEANUP FAILURE:', error instanceof Error ? error.message : String(error)); }
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
  console.log('OVERALL PUBLICATION PREPARATION RUNTIME VERIFICATION RESULT: PASS'); return true;
}

runPublicationPreparationRuntimeVerification().catch((error) => { console.error('OVERALL PUBLICATION PREPARATION RUNTIME VERIFICATION RESULT: FAIL', error); process.exitCode = 1; });
