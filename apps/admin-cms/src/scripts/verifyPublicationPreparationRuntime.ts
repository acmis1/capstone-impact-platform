import { createMockProject } from '../test/projectFixtures';
import { getPermissionsForRoles } from '../auth/permissions';
import { preparePublicationPlan } from '../projects/publicationPlanService';
async function main() {
  const projects = [createMockProject({ publicId: 'published-baseline', status: 'published' }), createMockProject({ publicId: 'ready-target', status: 'approved' }), createMockProject({ publicId: 'unrelated-approved', status: 'approved' })];
  const readiness = { ready: true, resultCode: 'READY' as const, blockers: [], confirmedPreviewId: 'confirmed-preview', confirmedAt: '2026-08-12T00:00:00.000Z' };
  const plan = await preparePublicationPlan(getPermissionsForRoles(['admin']), 'ready-target', { getReadiness: async () => readiness, listProjects: async () => projects });
  if (plan.resultCode !== 'READY_TO_STAGE' || plan.recordCount !== 2 || !plan.feedHash) throw new Error('READY candidate plan failed');
  const blocked = await preparePublicationPlan(getPermissionsForRoles(['reviewer']), 'ready-target', { getReadiness: async () => readiness, listProjects: async () => projects });
  if (blocked.resultCode !== 'PERMISSION_DENIED') throw new Error('Reviewer was not blocked');
  console.log('OVERALL PUBLICATION PREPARATION RUNTIME VERIFICATION RESULT: PASS');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
