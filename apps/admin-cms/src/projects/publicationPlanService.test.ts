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
  it('fails closed for incomplete readiness and dependency errors', async () => {
    const listProjects = async () => [createMockProject({ publicId: 'target', status: 'approved' })];
    await expect(preparePublicationPlan(getPermissionsForRoles(['admin']), 'target', { getReadiness: async () => ({ ...ready, confirmedPreviewId: undefined }), listProjects })).resolves.toMatchObject({ resultCode: 'NOT_READY' });
    await expect(preparePublicationPlan(getPermissionsForRoles(['admin']), 'target', { getReadiness: async () => ({ ...ready, confirmedAt: undefined }), listProjects })).resolves.toMatchObject({ resultCode: 'NOT_READY' });
    await expect(preparePublicationPlan(getPermissionsForRoles(['admin']), 'target', { getReadiness: async () => { throw new Error('db'); }, listProjects })).resolves.toEqual({ resultCode: 'PLAN_UNAVAILABLE' });
    await expect(preparePublicationPlan(getPermissionsForRoles(['admin']), 'target', { getReadiness: async () => ready, listProjects: async () => { throw new Error('db'); } })).resolves.toEqual({ resultCode: 'PLAN_UNAVAILABLE' });
  });
  it('denies reviewer/editor before dependencies execute', async () => {
    let calls = 0; const dependencies = { getReadiness: async () => { calls++; return ready; }, listProjects: async () => { calls++; return []; } };
    await expect(preparePublicationPlan(getPermissionsForRoles(['reviewer']), 'target', dependencies)).resolves.toEqual({ resultCode: 'PERMISSION_DENIED' });
    await expect(preparePublicationPlan(getPermissionsForRoles(['editor']), 'target', dependencies)).resolves.toEqual({ resultCode: 'PERMISSION_DENIED' });
    expect(calls).toBe(0);
  });
});
