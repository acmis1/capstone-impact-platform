import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';

import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

const FIXTURE_PREFIX = 'phase6b-browser-';
const PIPELINE = 'assistive-deterministic-checks/v2';

function v1Finding() {
  return {
    checkType: 'TITLE_CONSISTENCY', outcome: 'AGREES', classification: 'NON_BLOCKING',
    reasonCode: 'NORMALIZED_EXACT_MATCH', affectedField: 'title', origin: 'DETERMINISTIC_HELPER',
    scoreKind: null, scoreValue: null,
    evidence: {
      version: 'assistive-finding-evidence/v1', evidenceExcerpt: null, pageNumber: null,
      boundingBox: null, metadataValue: 'Phase 6B Browser Fixture',
      normalizedMetadataValue: 'phase 6b browser fixture', candidateValue: 'Phase 6B Browser Fixture',
      normalizedCandidateValue: 'phase 6b browser fixture',
      explanation: 'Synthetic title evidence for local browser verification.',
    },
  };
}

function duplicateFinding(candidates: Array<{
  publicId: string;
  title: string;
  summaryExcerpt: string;
  score: number;
  exact?: boolean;
  titleMatch?: boolean;
}>) {
  return {
    checkType: 'DUPLICATE_SHORTLIST', outcome: candidates.some((item) => item.exact || item.titleMatch) ? 'REVIEW' : 'INFORMATION',
    classification: 'NON_BLOCKING', reasonCode: candidates.some((item) => item.exact || item.titleMatch)
      ? 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT' : 'LEXICAL_DUPLICATE_SHORTLIST',
    affectedField: 'project_content', origin: 'DETERMINISTIC_HELPER', scoreKind: null, scoreValue: null,
    evidence: {
      version: 'assistive-finding-evidence/v2', evidenceExcerpt: null, pageNumber: null,
      boundingBox: null, metadataValue: null, normalizedMetadataValue: null,
      candidateValue: null, normalizedCandidateValue: null,
      explanation: 'Review these lexically similar project records. Staff decide whether any projects are duplicates.',
      duplicateCandidates: candidates.map((item, index) => ({
        rank: index + 1, publicId: item.publicId, title: item.title,
        summaryExcerpt: item.summaryExcerpt, lexicalScore: item.score,
        exactContentMatch: item.exact ?? false, normalizedTitleMatch: item.titleMatch ?? false,
      })),
    },
  };
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../../../..');
  const cli = path.resolve(root, 'node_modules/.bin/supabase');
  const env = parseSupabaseCliEnv(execSync(
    `"${cli}" status --workdir "${path.resolve(root, 'infra')}" -o env`,
    { cwd: root, encoding: 'utf8', stdio: 'pipe' },
  ));
  assert(env.API_URL && env.SERVICE_ROLE_KEY && isLoopbackUrl(env.API_URL), 'Loopback Local Supabase is required.');
  const service = createClient(env.API_URL, env.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const existing = await service.from('projects').select('id,public_id').like('public_id', `${FIXTURE_PREFIX}%`);
  assert.ifError(existing.error);
  const existingIds = (existing.data ?? []).map((row) => {
    assert(String(row.public_id).startsWith(FIXTURE_PREFIX));
    return String(row.id);
  });
  if (existingIds.length > 0) {
    const removed = await service.from('projects').delete().in('id', existingIds);
    assert.ifError(removed.error);
  }
  if (process.argv.includes('--cleanup')) {
    console.log(`Removed ${existingIds.length} verifier-owned Phase 6B browser fixture projects.`);
    return;
  }

  const actor = await service.from('admin_users').select('id').eq('email', 'local.reviewer@capstone.test').single();
  assert.ifError(actor.error);
  const actorId = String(actor.data!.id);
  const createdIds: string[] = [];
  const createProject = async (publicId: string, title: string, summary: string) => {
    const result = await service.from('projects').insert({
      public_id: publicId, title, summary,
      background: 'Synthetic local browser fixture background.',
      solution: 'Synthetic local browser fixture solution.',
      status: 'submitted', year: 2026, program_name: 'Synthetic Software Engineering',
      discipline: 'Software Engineering', group_name: `Synthetic ${publicId}`,
      team_members: ['Synthetic Browser Verifier'],
    }).select('id').single();
    assert.ifError(result.error);
    createdIds.push(String(result.data!.id));
    return String(result.data!.id);
  };

  const candidates = [
    { publicId: `${FIXTURE_PREFIX}candidate-1`, title: '<img src=x onerror=alert(1)> Literal candidate title', summaryExcerpt: '<script>alert("literal")</script> must render as text.', score: 1, exact: true },
    { publicId: `${FIXTURE_PREFIX}candidate-2`, title: 'Normalized Browser Fixture Title', summaryExcerpt: 'A normalized-title candidate.', score: 0.87, titleMatch: true },
    { publicId: `${FIXTURE_PREFIX}candidate-3`, title: 'Related Community Platform', summaryExcerpt: 'A bounded lexical comparison summary.', score: 0.73 },
    { publicId: `${FIXTURE_PREFIX}candidate-4`, title: 'Regional Monitoring Dashboard', summaryExcerpt: 'Another bounded comparison summary.', score: 0.61 },
    { publicId: `${FIXTURE_PREFIX}candidate-5`, title: 'Student Impact Archive', summaryExcerpt: 'The fifth deterministic shortlist entry.', score: 0.5 },
  ];
  for (const candidate of candidates) {
    await createProject(candidate.publicId, candidate.title, candidate.summaryExcerpt);
  }

  const targets = [
    { publicId: `${FIXTURE_PREFIX}zero`, findings: [v1Finding()] },
    { publicId: `${FIXTURE_PREFIX}one`, findings: [v1Finding(), duplicateFinding(candidates.slice(0, 1))] },
    { publicId: `${FIXTURE_PREFIX}five`, findings: [v1Finding(), duplicateFinding(candidates)] },
  ];
  for (const target of targets) {
    const projectId = await createProject(target.publicId, 'Phase 6B Browser Fixture', `Synthetic ${target.publicId} target.`);
    const persisted = await service.rpc('persist_assistive_validation_run', {
      p_project_id: projectId,
      p_actor_admin_id: actorId,
      p_input_hash: crypto.createHash('sha256').update(target.publicId).digest('hex'),
      p_pipeline_version: PIPELINE,
      p_status: 'COMPLETED',
      p_failure_code: null,
      p_findings: target.findings,
    });
    assert.ifError(persisted.error);
    assert.equal((persisted.data as { resultCode?: string }).resultCode, 'PERSISTED');
  }

  assert.equal(createdIds.length, 8);
  console.log('Prepared verifier-owned Local Supabase browser fixtures:');
  for (const target of targets) console.log(`/admin/projects/${target.publicId}`);
}

main().catch((error) => {
  console.error('Phase 6B browser fixture preparation failed:', error);
  process.exit(1);
});
