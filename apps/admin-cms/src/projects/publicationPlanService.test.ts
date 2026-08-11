import { describe, expect, it } from 'vitest';
import { getPermissionsForRoles } from '../auth/permissions';
import { createMockProject } from '../test/projectFixtures';
import { preparePublicationPlan } from './publicationPlanService';
const ready = { ready: true, resultCode: 'READY' as const, blockers: [], confirmedPreviewId: 'preview-1', confirmedAt: '2026-01-01T00:00:00.000Z' };
describe('preparePublicationPlan', () => {
  it('returns bounded evidence after fresh readiness', async () => expect(await preparePublicationPlan(getPermissionsForRoles(['admin']), 'target', { getReadiness: async () => ready, listProjects: async () => [createMockProject({ publicId: 'target', status: 'approved' })] })).toMatchObject({ resultCode: 'READY_TO_STAGE', publicId: 'target', recordCount: 1 }));
  it('fails closed for stale readiness and non-admins', async () => {
    const deps = { getReadiness: async () => ({ ready: false, resultCode: 'NO_ACTIVE_PREVIEW' as const, blockers: ['Preview required'] }), listProjects: async () => [] };
    await expect(preparePublicationPlan(getPermissionsForRoles(['admin']), 'target', deps)).resolves.toMatchObject({ resultCode: 'NOT_READY' });
    await expect(preparePublicationPlan(getPermissionsForRoles(['reviewer']), 'target', deps)).resolves.toEqual({ resultCode: 'PERMISSION_DENIED' });
  });
});
