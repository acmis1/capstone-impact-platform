import { describe, expect, it, vi } from 'vitest';
import {
  canChangeProjectLayout,
  ProjectLayoutMaintenancePermissionError,
  updateProjectLayout,
} from './projectLayoutMaintenance';

const config = {
  templateId: 'technical_detail' as const,
  featuredMedia: 'snapshots' as const,
  sectionOrder: ['solution', 'background', 'snapshots', 'video', 'team', 'links', 'citations', 'accessibilityText'] as const,
  hiddenSections: [] as const,
};
const actor = { adminId: '11111111-1111-4111-8111-111111111111', roles: ['admin'] as Array<'admin'>, permissions: ['projects.edit'] as Array<'projects.edit'> };
const input = {
  publicId: 'synthetic-project',
  expectedUpdatedAt: '2026-09-18T10:00:00.000Z',
  layoutConfig: config,
};

describe('project layout maintenance authority', () => {
  it('requires an active administrator permission and passes the server actor to the gateway', async () => {
    expect(canChangeProjectLayout(actor)).toBe(true);
    expect(canChangeProjectLayout({ adminId: actor.adminId, roles: ['reviewer'], permissions: ['projects.edit'] })).toBe(false);
    expect(canChangeProjectLayout({ adminId: actor.adminId, roles: ['admin'], permissions: [] })).toBe(false);

    const update = vi.fn(async (value) => ({ resultCode: 'UPDATED' as const, publicId: value.publicId, status: 'draft' as const, updatedAt: value.expectedUpdatedAt, auditRecordId: '22222222-2222-4222-8222-222222222222', revokedActivePreviewCount: 1 }));
    await expect(updateProjectLayout({ actor, gateway: { update }, input })).resolves.toMatchObject({ resultCode: 'UPDATED' });
    expect(update).toHaveBeenCalledWith({ ...input, recipeVersionId: null, adminId: actor.adminId });
  });

  it('rejects null, unknown-key and malformed layout configs before any write', async () => {
    const update = vi.fn();
    for (const layoutConfig of [null, { ...config, templateId: null }, { ...config, unexpected: true }]) {
      await expect(updateProjectLayout({ actor, gateway: { update }, input: { ...input, layoutConfig } })).resolves.toEqual({ resultCode: 'VALIDATION_FAILED' });
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('does not let a non-admin reach the gateway', async () => {
    const update = vi.fn();
    await expect(updateProjectLayout({ actor: { ...actor, roles: ['editor'] }, gateway: { update }, input }))
      .rejects.toBeInstanceOf(ProjectLayoutMaintenancePermissionError);
    expect(update).not.toHaveBeenCalled();
  });
});
