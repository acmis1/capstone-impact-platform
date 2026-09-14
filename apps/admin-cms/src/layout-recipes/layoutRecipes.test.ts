import { describe, expect, it, vi } from 'vitest';
import { getPermissionsForRoles } from '../auth/permissions';
import { createLayoutConfigFromStock } from '../domain/layoutConfig';
import { manageLayoutRecipe, type LayoutRecipeGateway } from './layoutRecipes';

function gateway(): LayoutRecipeGateway {
  return {
    create: vi.fn().mockResolvedValue({ resultCode: 'CREATED', recipeVersionId: '11111111-1111-4111-8111-111111111111' }),
    duplicate: vi.fn().mockResolvedValue({ resultCode: 'DUPLICATED', recipeVersionId: '22222222-2222-4222-8222-222222222222' }),
    version: vi.fn().mockResolvedValue({ resultCode: 'VERSIONED', recipeVersionId: '33333333-3333-4333-8333-333333333333' }),
    retire: vi.fn().mockResolvedValue({ resultCode: 'RETIRED', recipeVersionId: '44444444-4444-4444-8444-444444444444' }),
  };
}

const actorAdminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sourceVersionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('layout recipe management service', () => {
  it('denies non-admin writes before any persistence call', async () => {
    const persistence = gateway();
    const result = await manageLayoutRecipe({
      permissions: getPermissionsForRoles(['editor']), actorAdminId, gateway: persistence,
      input: { action: 'create', name: 'Team first', config: createLayoutConfigFromStock('poster_showcase') },
    });
    expect(result).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(persistence.create).not.toHaveBeenCalled();
  });

  it('creates, duplicates, versions, and retires through bounded commands', async () => {
    const persistence = gateway();
    const permissions = getPermissionsForRoles(['admin']);
    const config = createLayoutConfigFromStock('poster_showcase');
    await expect(manageLayoutRecipe({ permissions, actorAdminId, gateway: persistence, input: { action: 'create', name: 'Team first', config } }))
      .resolves.toMatchObject({ ok: true, code: 'CREATED' });
    await expect(manageLayoutRecipe({ permissions, actorAdminId, gateway: persistence, input: { action: 'duplicate', name: 'Team first copy', sourceVersionId } }))
      .resolves.toMatchObject({ ok: true, code: 'DUPLICATED' });
    await expect(manageLayoutRecipe({ permissions, actorAdminId, gateway: persistence, input: { action: 'version', name: 'Team first revised', sourceVersionId, expectedVersion: 1, config } }))
      .resolves.toMatchObject({ ok: true, code: 'VERSIONED' });
    await expect(manageLayoutRecipe({ permissions, actorAdminId, gateway: persistence, input: { action: 'retire', sourceVersionId, expectedVersion: 2 } }))
      .resolves.toMatchObject({ ok: true, code: 'RETIRED' });
  });

  it('rejects extra authority fields, malformed IDs, unsafe config, and oversized names', async () => {
    const persistence = gateway();
    const permissions = getPermissionsForRoles(['admin']);
    const valid = createLayoutConfigFromStock('poster_showcase');
    for (const input of [
      { action: 'create', name: 'x'.repeat(121), config: valid },
      { action: 'create', name: 'Unsafe', config: { ...valid, sectionOrder: [...valid.sectionOrder, 'html'] } },
      { action: 'duplicate', name: 'Copy', sourceVersionId: 'not-a-uuid' },
      { action: 'retire', sourceVersionId, expectedVersion: 1, permissions: ['taxonomy.manage'] },
    ]) {
      await expect(manageLayoutRecipe({ permissions, actorAdminId, gateway: persistence, input }))
        .resolves.toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    }
    expect(persistence.create).not.toHaveBeenCalled();
    expect(persistence.duplicate).not.toHaveBeenCalled();
    expect(persistence.retire).not.toHaveBeenCalled();
  });

  it('surfaces optimistic version conflicts without retrying a stale command', async () => {
    const persistence = gateway();
    vi.mocked(persistence.version).mockResolvedValue({ resultCode: 'VERSION_CONFLICT' });
    const result = await manageLayoutRecipe({
      permissions: getPermissionsForRoles(['admin']), actorAdminId, gateway: persistence,
      input: { action: 'version', name: 'Reload me', sourceVersionId, expectedVersion: 3, config: createLayoutConfigFromStock('media_rich') },
    });
    expect(result).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });
    expect(persistence.version).toHaveBeenCalledTimes(1);
  });
});
