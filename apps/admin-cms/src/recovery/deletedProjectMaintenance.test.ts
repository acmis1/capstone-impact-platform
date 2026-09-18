import { describe, expect, it } from 'vitest';
import { canManageDeletedProjects, deletedProjectPageQuerySchema, recoverDeletedProjectInputSchema } from './deletedProjectMaintenance';

describe('deleted project maintenance authority', () => {
  it('requires administrator delete permission and bounded 20/50 pagination', () => {
    expect(canManageDeletedProjects({ adminId: '11111111-1111-4111-8111-111111111111', roles: ['admin'], permissions: ['projects.delete'] })).toBe(true);
    expect(canManageDeletedProjects({ adminId: '11111111-1111-4111-8111-111111111111', roles: ['reviewer'], permissions: ['projects.delete'] })).toBe(false);
    expect(canManageDeletedProjects({ adminId: '11111111-1111-4111-8111-111111111111', roles: ['admin'], permissions: [] })).toBe(false);
    expect(deletedProjectPageQuerySchema.safeParse({ page: 1, pageSize: 20 }).success).toBe(true);
    expect(deletedProjectPageQuerySchema.safeParse({ page: 1, pageSize: 10 }).success).toBe(false);
    expect(deletedProjectPageQuerySchema.safeParse({ page: 1, pageSize: 50, search: 'x'.repeat(101) }).success).toBe(false);
  });

  it('requires both exact tombstone CAS values and rejects body extras', () => {
    const valid = {
      publicId: 'synthetic-deleted',
      expectedUpdatedAt: '2026-09-18T10:00:00.000Z',
      expectedDeletedAt: '2026-09-18T09:00:00.000Z',
    };
    expect(recoverDeletedProjectInputSchema.safeParse(valid).success).toBe(true);
    expect(recoverDeletedProjectInputSchema.safeParse({ ...valid, expectedDeletedAt: null }).success).toBe(false);
    expect(recoverDeletedProjectInputSchema.safeParse({ ...valid, csrf: 'unexpected' }).success).toBe(false);
  });
});
