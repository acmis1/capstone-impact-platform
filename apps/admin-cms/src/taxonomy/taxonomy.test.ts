import { describe, expect, it, vi } from 'vitest';
import { canManageTaxonomy, getPermissionsForRoles } from '../auth/permissions';
import {
  createTaxonomyEntry,
  TaxonomyConflictError,
  transitionTaxonomyEntry,
  type TaxonomyGateway,
} from './taxonomy';

const ENTRY_ID = '11111111-1111-1111-8111-111111111111';

function gateway(overrides: Partial<TaxonomyGateway> = {}): TaxonomyGateway {
  return {
    create: vi.fn(async (_kind, name) => ({ id: ENTRY_ID, name })),
    ...overrides,
  };
}

describe('taxonomy authority and management contract', () => {
  it('keeps taxonomy mutation in the centralized administrator-only permission model', () => {
    expect(canManageTaxonomy(getPermissionsForRoles(['admin']))).toBe(true);
    expect(canManageTaxonomy(getPermissionsForRoles(['reviewer']))).toBe(false);
    expect(canManageTaxonomy(getPermissionsForRoles(['editor']))).toBe(false);
  });

  it('trims a valid institutional value without altering its remaining text', async () => {
    const store = gateway();
    await expect(createTaxonomyEntry(store, 'program', { name: '  Future Program — synthetic proof  ' }))
      .resolves.toEqual({ ok: true, code: 'CREATED', entry: { id: ENTRY_ID, name: 'Future Program — synthetic proof' } });
    expect(store.create).toHaveBeenCalledWith('program', 'Future Program — synthetic proof');
  });

  it.each([
    { name: '   ' },
    { name: 'x'.repeat(121) },
    { name: ['not a name'] },
    { unexpected: 'field' },
  ])('rejects malformed or unbounded catalogue input', async (input) => {
    await expect(createTaxonomyEntry(gateway(), 'discipline', input)).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
    });
  });

  it('returns a bounded deterministic conflict for a duplicate create', async () => {
    const store = gateway({ create: vi.fn(async () => { throw new TaxonomyConflictError(); }) });
    await expect(createTaxonomyEntry(store, 'program', { name: 'IT' })).resolves.toEqual({
      ok: false,
      code: 'DUPLICATE',
      message: 'That catalogue value already exists.',
    });
  });

  it('converges concurrent duplicate creates through the catalogue uniqueness boundary', async () => {
    let created = false;
    const store = gateway({
      create: vi.fn(async (_kind, name) => {
        await Promise.resolve();
        if (created) throw new TaxonomyConflictError();
        created = true;
        return { id: ENTRY_ID, name };
      }),
    });

    const results = await Promise.all([
      createTaxonomyEntry(store, 'program', { name: 'Future Program' }),
      createTaxonomyEntry(store, 'program', { name: 'Future Program' }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === 'DUPLICATE')).toHaveLength(1);
  });

  it('maps lifecycle CAS, rename-reference refusal, and unchanged responses without rewriting references', async () => {
    const lifecycle = vi.fn()
      .mockResolvedValueOnce({ resultCode: 'REFERENCED_RENAME_BLOCKED', referenceCount: 2 })
      .mockResolvedValueOnce({ resultCode: 'STALE_VERSION', lifecycleVersion: 3 })
      .mockResolvedValueOnce({ resultCode: 'UNCHANGED', id: ENTRY_ID, name: 'Existing value', retiredAt: null, lifecycleVersion: 2 });
    const store = gateway({ lifecycle });

    await expect(transitionTaxonomyEntry(store, 'program', '22222222-2222-4222-8222-222222222222', {
      action: 'rename', id: ENTRY_ID, expectedLifecycleVersion: 1, name: 'Corrected value',
    })).resolves.toMatchObject({ ok: false, code: 'REFERENCED_RENAME_BLOCKED' });
    await expect(transitionTaxonomyEntry(store, 'program', '22222222-2222-4222-8222-222222222222', {
      action: 'retire', id: ENTRY_ID, expectedLifecycleVersion: 1,
    })).resolves.toMatchObject({ ok: false, code: 'STALE_VERSION' });
    await expect(transitionTaxonomyEntry(store, 'program', '22222222-2222-4222-8222-222222222222', {
      action: 'reactivate', id: ENTRY_ID, expectedLifecycleVersion: 2,
    })).resolves.toEqual({ ok: true, code: 'UNCHANGED', entry: { id: ENTRY_ID, name: 'Existing value', retiredAt: null, lifecycleVersion: 2 } });
    expect(lifecycle).toHaveBeenCalledTimes(3);
  });
});
