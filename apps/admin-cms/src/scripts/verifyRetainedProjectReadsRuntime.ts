import assert from 'node:assert/strict';
import {
  createPublicFeedRuntimeHarness,
  requireDisposableRuntime,
} from './publicFeedRuntimeSupport';

const API_CAP = 37;
const RETAINED_PROJECT_COUNT = 120;

async function main(): Promise<void> {
  const { projectId } = requireDisposableRuntime();
  const harness = await createPublicFeedRuntimeHarness();
  const rows = Array.from({ length: RETAINED_PROJECT_COUNT }, (_, index) => {
    const ordinal = String(index + 1).padStart(3, '0');
    return {
      public_id: `retained-${ordinal}`,
      title: `Synthetic retained project ${ordinal}`,
      slug: `retained-${ordinal}`,
      summary: 'Synthetic retained-project read verifier record.',
      year: 2026,
      status: 'draft',
    };
  });

  const inserted = await harness.db.from('projects').insert(rows);
  assert.equal(inserted.error, null, inserted.error?.message);

  const counted = await harness.db.from('projects')
    .select('id', { count: 'exact', head: true })
    .is('deleted_at', null);
  assert.equal(counted.error, null, counted.error?.message);
  assert.equal(counted.count, RETAINED_PROJECT_COUNT);

  const cappedProbe = await harness.db.from('projects')
    .select('public_id')
    .is('deleted_at', null)
    .order('public_id', { ascending: true })
    .limit(1000);
  assert.equal(cappedProbe.error, null, cappedProbe.error?.message);
  assert.equal(cappedProbe.data?.length, API_CAP, 'The real PostgREST response cap was not exercised.');

  const projects = await harness.projects.listProjects();
  const expectedPublicIds = rows.map((row) => row.public_id);
  const actualPublicIds = projects.map((project) => project.publicId).sort();
  assert.equal(projects.length, RETAINED_PROJECT_COUNT);
  assert.equal(new Set(actualPublicIds).size, RETAINED_PROJECT_COUNT);
  assert.deepEqual(actualPublicIds, expectedPublicIds);

  const targetIds = [expectedPublicIds[0], expectedPublicIds[59], expectedPublicIds[119]];
  for (const publicId of targetIds) {
    const project = await harness.projects.getProjectByPublicId(publicId);
    assert.equal(project?.publicId, publicId);
  }

  const deleted = await harness.db.from('projects')
    .update({ status: 'deleted', deleted_at: new Date('2026-09-14T00:00:00.000Z').toISOString() })
    .eq('public_id', targetIds[1]);
  assert.equal(deleted.error, null, deleted.error?.message);
  assert.equal(await harness.projects.getProjectByPublicId(targetIds[1]), null);
  const afterSoftDelete = await harness.projects.listProjects();
  assert.equal(afterSoftDelete.length, RETAINED_PROJECT_COUNT - 1);
  assert.equal(afterSoftDelete.some((project) => project.publicId === targetIds[1]), false);

  console.log(JSON.stringify({
    result: 'PASS',
    runtime: 'owned-disposable-loopback-supabase-postgrest',
    projectId,
    apiCap: API_CAP,
    insertedRows: RETAINED_PROJECT_COUNT,
    cappedProbeRows: cappedProbe.data?.length,
    completeReadRows: projects.length,
    completeIdentityCount: new Set(actualPublicIds).size,
    exactTargets: targetIds,
    afterSoftDeleteRows: afterSoftDelete.length,
  }, null, 2));
}

void main();
