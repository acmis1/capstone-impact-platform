import { describe, expect, it, vi } from 'vitest';
import type { SoftDeletePreflightItem } from './projectSoftDelete';
import {
  ProjectSoftDeletePermissionError,
  ProjectSoftDeleteService,
  type ProjectSoftDeleteGateway,
} from './projectSoftDeleteService';

const eligible = (publicId: string): SoftDeletePreflightItem => ({
  publicId,
  title: publicId,
  status: 'draft',
  updatedAt: '2026-09-17T00:00:00.000Z',
  disposition: 'eligible',
  reasonCode: 'ELIGIBLE',
  reason: 'Eligible.',
  previouslyPublished: false,
});

function gateway(items: SoftDeletePreflightItem[] = [eligible('p-1')]): ProjectSoftDeleteGateway {
  return {
    preflight: vi.fn().mockResolvedValue(items),
    execute: vi.fn().mockResolvedValue({
      resultCode: 'DELETED', publicId: 'p-1', status: 'deleted', fromStatus: 'draft',
      deletedAt: '2026-09-17T00:00:01.000Z', auditRecordId: '11111111-1111-4111-8111-111111111111',
    }),
  };
}

describe('ProjectSoftDeleteService', () => {
  const admin = { adminId: 'admin-1', permissions: ['projects.delete'] as const };

  it('allows the administrator-only delete permission and returns truthful preflight totals', async () => {
    const service = new ProjectSoftDeleteService(gateway([
      eligible('eligible'),
      { ...eligible('published'), status: 'published', disposition: 'blocked', reasonCode: 'PUBLISHED_REQUIRES_ARCHIVE', reason: 'Archive first.', previouslyPublished: true },
      { ...eligible('deleted'), status: 'deleted', disposition: 'already_deleted', reasonCode: 'ALREADY_DELETED', reason: 'Already deleted.' },
    ]));
    await expect(service.preflight({ publicIds: ['eligible', 'published', 'deleted'], actor: { ...admin, permissions: [...admin.permissions] } })).resolves.toMatchObject({
      summary: { total: 3, eligible: 1, blocked: 1, alreadyDeleted: 1 },
    });
  });

  it.each([
    ['reviewer', ['projects.review']],
    ['editor', ['projects.edit']],
    ['archiver', ['projects.archive']],
  ])('denies %s authority before touching the gateway', async (_label, permissions) => {
    const subject = gateway();
    const service = new ProjectSoftDeleteService(subject);
    await expect(service.preflight({ publicIds: ['p-1'], actor: { adminId: 'staff-1', permissions: permissions as never } }))
      .rejects.toBeInstanceOf(ProjectSoftDeletePermissionError);
    await expect(service.execute({ publicId: 'p-1', expectedUpdatedAt: '2026-09-17T00:00:00.000Z', actor: { adminId: 'staff-1', permissions: permissions as never } }))
      .rejects.toBeInstanceOf(ProjectSoftDeletePermissionError);
    expect(subject.preflight).not.toHaveBeenCalled();
    expect(subject.execute).not.toHaveBeenCalled();
  });

  it('rejects incomplete or reordered database preflight results', async () => {
    const service = new ProjectSoftDeleteService(gateway([eligible('p-2'), eligible('p-1')]));
    await expect(service.preflight({ publicIds: ['p-1', 'p-2'], actor: { ...admin, permissions: [...admin.permissions] } }))
      .rejects.toThrow('incomplete');
  });
});
