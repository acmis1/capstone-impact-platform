import { describe, expect, it, vi } from 'vitest';
import { canManageTaxonomy, getPermissionsForRoles } from '../auth/permissions';
import {
  createTaxonomyEntry,
  removeTaxonomyEntry,
  type TaxonomyGateway,
} from './taxonomy';

const ENTRY_ID = '11111111-1111-1111-8111-111111111111';

function gateway(overrides: Partial<TaxonomyGateway> = {}): TaxonomyGateway {
  return {
    create: vi.fn(async (_kind, name) => ({ id: ENTRY_ID, name })),
    isReferenced: vi.fn(async () => false),
    remove: vi.fn(async () => true),
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
    const store = gateway({ create: vi.fn(async () => { throw new (await import('./taxonomy')).TaxonomyConflictError(); }) });
    await expect(createTaxonomyEntry(store, 'program', { name: 'IT' })).resolves.toEqual({
      ok: false,
      code: 'DUPLICATE',
      message: 'That catalogue value already exists.',
    });
  });

  it('never issues delete for a catalogue row referenced by projects', async () => {
    const store = gateway({ isReferenced: vi.fn(async () => true) });
    await expect(removeTaxonomyEntry(store, 'discipline', { id: ENTRY_ID })).resolves.toMatchObject({
      ok: false,
      code: 'IN_USE',
    });
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('allows an unused accidental value to be removed', async () => {
    const store = gateway();
    await expect(removeTaxonomyEntry(store, 'industryCategory', { id: ENTRY_ID })).resolves.toEqual({
      ok: true,
      code: 'REMOVED',
    });
    expect(store.remove).toHaveBeenCalledWith('industryCategory', ENTRY_ID);
  });
});
