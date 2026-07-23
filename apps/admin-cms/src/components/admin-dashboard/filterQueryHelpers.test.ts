import { describe, it, expect } from 'vitest';
import { buildQueryString } from './filterQueryHelpers';

describe('filterQueryHelpers', () => {
  it('resets page parameter when search or filters change', () => {
    const current = 'page=3&status=draft';
    const updated = buildQueryString(current, { q: 'AI' });
    expect(updated).toBe('status=draft&q=AI');
  });

  it('resets page parameter when filter is updated', () => {
    const current = 'page=2&year=2026';
    const updated = buildQueryString(current, { status: 'approved' });
    expect(updated).toBe('year=2026&status=approved');
  });

  it('preserves filters when page is explicitly updated', () => {
    const current = 'status=in_review&year=2026';
    const updated = buildQueryString(current, { page: 4 });
    expect(updated).toBe('status=in_review&year=2026&page=4');
  });

  it('deletes parameter when set to null, undefined, or empty string', () => {
    const current = 'status=approved&year=2026&q=test';
    const updated = buildQueryString(current, { q: null, status: '' });
    expect(updated).toBe('year=2026');
  });
});
