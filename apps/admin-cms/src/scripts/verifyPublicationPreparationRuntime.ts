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
  const list = async (bucket: string) => { const result = await db.storage.from(bucket).list('', { limit: 1000 }); if (result.error) throw result.error; return JSON.stringify(result.data ?? []); };
  const baseline = { feeds: await list('public-feeds'), assets: await list('project-public-assets'), snapshots: (await db.from('published_snapshots').select('id', { count: 'exact', head: true })).count ?? 0 };
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
  try {
    console.log('Scenario 1: READY target'); const published = await create('baseline', 'published'); const target = await ready('target'); await create('unrelated'); const first = await plan(target.project.public_id); assert(first.resultCode === 'READY_TO_STAGE' && first.publicId === target.project.public_id, 'READY plan failed');
    console.log('Scenario 2: candidate membership'); const expectedFeed = compilePublicationCandidateFeed(await projects.listProjects(), target.project.public_id); const expected = serializePublicFeedArtifact(expectedFeed); assert(expectedFeed.map((record) => record.publicId).join(',') === `${published.public_id},${target.project.public_id}` && first.resultCode === 'READY_TO_STAGE' && first.recordCount === 2 && first.feedHash === expected.feedHash, 'Candidate membership/hash mismatch');
    console.log('Scenario 3: confirmation evidence'); assert(first.resultCode === 'READY_TO_STAGE' && first.confirmedPreviewId === target.preview.previewId && first.confirmedAt === target.confirmation.confirmedAt, 'Confirmation evidence mismatch');
    console.log('Scenario 4: deterministic artifact'); assert(expected.content === serializePublicFeedArtifact(compilePublicationCandidateFeed(await projects.listProjects(), target.project.public_id)).content, 'Artifact bytes unstable');
    console.log('Scenario 5: reviewer blocked'); assert((await plan(target.project.public_id, 'reviewer')).resultCode === 'PERMISSION_DENIED', 'Reviewer permitted');
    console.log('Scenario 6: editor blocked'); assert((await plan(target.project.public_id, 'editor')).resultCode === 'PERMISSION_DENIED', 'Editor permitted');
    console.log('Scenario 7: unconfirmed target'); const unconfirmed = await create('unconfirmed'); await previews.generatePreview({ publicId: unconfirmed.public_id, adminId, tokenHash: hash(crypto.randomUUID()), privateBucket: BUCKET }); assert((await plan(unconfirmed.public_id)).resultCode === 'NOT_READY', 'Unconfirmed plan allowed');
    console.log('Scenario 8: correction unresolved'); const correction = await ready('correction'); await db.from('participant_preview_correction_requests').insert({ participant_preview_id: correction.preview.previewId, correction_comment: 'Synthetic correction', status: 'open' }); assert((await plan(correction.project.public_id)).resultCode === 'NOT_READY', 'Correction plan allowed');
    console.log('Scenario 9: metadata drift'); const metadata = await ready('metadata'); await db.from('projects').update({ title: 'Drifted' }).eq('id', metadata.project.id); assert((await plan(metadata.project.public_id)).resultCode === 'NOT_READY', 'Metadata drift allowed');
    console.log('Scenario 10: private-media drift'); const media = await ready('media'); await db.from('project_media').insert({ project_id: media.project.id, storage_bucket: BUCKET, storage_path: `${prefix}/extra.png`, file_name: 'extra.png', mime_type: 'image/png', size_bytes: 1, media_type: 'image', is_public_approved: false }); assert((await plan(media.project.public_id)).resultCode === 'NOT_READY', 'Media drift allowed');
    console.log('Scenario 11: revoked preview freshness'); const revoked = await ready('revoked'); await previews.revokePreview({ publicId: revoked.project.public_id, adminId }); assert((await plan(revoked.project.public_id)).resultCode === 'NOT_READY', 'Revoked preview allowed');
    console.log('Scenario 12: project state drift'); const state = await ready('state'); await db.from('projects').update({ status: 'changes_requested' }).eq('id', state.project.id); assert((await plan(state.project.public_id)).resultCode === 'NOT_READY', 'State drift allowed');
    console.log('Scenario 13: sequential repeat'); const repeat = await ready('repeat'); const [one, two] = [await plan(repeat.project.public_id), await plan(repeat.project.public_id)]; assert(JSON.stringify(one) === JSON.stringify(two), 'Repeat plan changed');
    console.log('Scenario 14: concurrent requests'); const concurrent = await Promise.all([plan(repeat.project.public_id), plan(repeat.project.public_id)]); assert(JSON.stringify(concurrent[0]) === JSON.stringify(concurrent[1]), 'Concurrent plan changed');
    console.log('Scenario 15: zero database/publication side effects'); assert((await db.from('published_snapshots').select('id', { count: 'exact', head: true })).count === baseline.snapshots, 'Published snapshot changed');
    console.log('Scenario 16: zero public-storage side effects'); assert(await list('public-feeds') === baseline.feeds && await list('project-public-assets') === baseline.assets, 'Public storage changed');
  } finally {
    console.log('Scenario 17: independent cleanup');
    if (owned.length) { const result = await db.from('projects').delete().in('id', owned); if (result.error) throw result.error; }
    const residue = await db.from('projects').select('id', { count: 'exact', head: true }).like('public_id', `${prefix}%`); assert((residue.count ?? 0) === 0, 'Fixture cleanup residue remains');
    assert(await list('public-feeds') === baseline.feeds && await list('project-public-assets') === baseline.assets, 'Cleanup public storage mismatch');
  }
  console.log('OVERALL PUBLICATION PREPARATION RUNTIME VERIFICATION RESULT: PASS'); return true;
}

runPublicationPreparationRuntimeVerification().catch((error) => { console.error('OVERALL PUBLICATION PREPARATION RUNTIME VERIFICATION RESULT: FAIL', error); process.exitCode = 1; });
