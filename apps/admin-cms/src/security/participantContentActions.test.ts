import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveProjectMetadataAction, saveSnapshotAltTextAction } from '../app/admin/projects/[publicId]/actions';
import { requireAdmin } from '../auth/requireAdmin';
import { AdminAuthError } from '../auth/authTypes';
import { getPermissionsForRoles } from '../auth/permissions';
import { createSupabaseAdminClient } from '../lib/supabase/admin';

vi.mock('../auth/requireAdmin', () => ({ requireAdmin: vi.fn() }));
vi.mock('../lib/supabase/admin', () => ({ createSupabaseAdminClient: vi.fn(() => { throw new Error('Database must not be reached'); }) }));
beforeEach(() => vi.clearAllMocks());

describe('actual legacy staff server actions', () => {
  for (const action of [saveProjectMetadataAction, saveSnapshotAltTextAction]) {
    it.each(['admin', 'editor'] as const)(`${action.name} denies direct %s content writes without a database client`, async (role) => {
      vi.mocked(requireAdmin).mockResolvedValue({ permissions: getPermissionsForRoles([role]) } as never);
      expect(await action({ title: 'Override', altText: 'Override', publicId: 'arbitrary' })).toMatchObject({ ok: false, code: 'PARTICIPANT_CONTENT_OWNED' });
      expect(createSupabaseAdminClient).not.toHaveBeenCalled();
    });
    it(`${action.name} fails closed for reviewers and anonymous callers`, async () => {
      vi.mocked(requireAdmin).mockResolvedValue({ permissions: getPermissionsForRoles(['reviewer']) } as never);
      expect(await action({})).toMatchObject({ code: 'PERMISSION_DENIED' });
      vi.mocked(requireAdmin).mockRejectedValue(new AdminAuthError('UNAUTHENTICATED', 'Private authentication detail'));
      expect(await action({})).toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(createSupabaseAdminClient).not.toHaveBeenCalled();
    });
  }
});
