import { describe, expect, it } from 'vitest';
import { parseStaffDirectoryQuery, selectStaffDirectoryPage, staffDirectoryHref } from './staffDirectoryQuery';
import type { StaffDirectoryEntry } from './staffProvisioningRepository';

const staff = Array.from({ length: 55 }, (_, index) => ({ fullName: `Synthetic Staff ${index}`, email: `staff-${index}@example.invalid`, status: index % 2 ? 'active' : 'deactivated', roles: ['editor'], version: 1, providerSync: 'synchronized', lastChangedAt: null, requestedAt: null })) as StaffDirectoryEntry[];
describe('staff directory bounded display navigation', () => {
  it('paginates filtered results without changing full-directory summary inputs', () => {
    const query = parseStaffDirectoryQuery({ status: 'active', page: '2' });
    const result = selectStaffDirectoryPage(staff, query);
    expect(result.matching).toBe(27);
    expect(result.pages).toBe(2);
    expect(result.staff).toHaveLength(7);
    expect(result.staff.every(entry => entry.status === 'active')).toBe(true);
    expect(staff).toHaveLength(55);
    expect(selectStaffDirectoryPage(staff, parseStaffDirectoryQuery({ q: 'STAFF-51@EXAMPLE.INVALID' })).staff).toEqual([staff[51]]);
  });
  it('bounds input and does not propagate extra query keys', () => {
    for (const query of [{ page: '-1' }, { q: 'x'.repeat(101) }, { status: 'owner' }]) expect(() => parseStaffDirectoryQuery(query)).toThrow();
    const query = parseStaffDirectoryQuery({ q: 'Synthetic', status: 'active', token: 'not-forwarded' });
    const url = new URL(staffDirectoryHref(query, 2), 'https://example.invalid');
    expect(url.searchParams.get('q')).toBe('Synthetic');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.has('token')).toBe(false);
  });
});
