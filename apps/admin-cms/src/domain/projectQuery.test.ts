import { describe, it, expect } from 'vitest';
import { parseProjectListQuery, normalizeSearchInput, MAX_PROJECT_INDEX_PAGE } from './projectQuery';

describe('projectQuery domain logic', () => {
  describe('normalizeSearchInput', () => {
    it('returns empty string for non-string input', () => {
      expect(normalizeSearchInput(undefined)).toBe('');
      expect(normalizeSearchInput(null)).toBe('');
      expect(normalizeSearchInput(123)).toBe('');
    });

    it('trims whitespace and removes control characters', () => {
      expect(normalizeSearchInput('  hello\x00world\x1F  ')).toBe('helloworld');
    });

    it('strips PostgREST operators and special characters via conservative allowlist', () => {
      const rawInjected = 'title:eq.test(123),select*%20;\'"\\_DROP--';
      const normalized = normalizeSearchInput(rawInjected);

      expect(normalized).toBe('title eq test 123 select 20 DROP--');
      expect(normalized).not.toContain(':');
      expect(normalized).not.toContain('.');
      expect(normalized).not.toContain('(');
      expect(normalized).not.toContain(')');
      expect(normalized).not.toContain(',');
      expect(normalized).not.toContain('*');
      expect(normalized).not.toContain('%');
      expect(normalized).not.toContain(';');
      expect(normalized).not.toContain('\'');
      expect(normalized).not.toContain('"');
      expect(normalized).not.toContain('\\');
      expect(normalized).not.toContain('_');
    });

    it('clamps length to 100 characters', () => {
      const longInput = 'a'.repeat(150);
      expect(normalizeSearchInput(longInput).length).toBe(100);
    });
  });

  describe('parseProjectListQuery', () => {
    it('provides safe default values for empty params', () => {
      const result = parseProjectListQuery({});
      expect(result).toEqual({
        search: undefined,
        status: undefined,
        year: undefined,
        program: undefined,
        discipline: undefined,
        sort: 'created_at',
        direction: 'desc',
        page: 1,
        pageSize: 10,
      });
    });

    it('parses valid search and filter options', () => {
      const params = {
        q: '  AI Assistant  ',
        status: 'approved',
        year: '2026',
        program: 'Software Engineering',
        discipline: 'AI',
        sort: 'title',
        direction: 'asc',
        page: '2',
        pageSize: '25',
      };

      const result = parseProjectListQuery(params);
      expect(result).toEqual({
        search: 'AI Assistant',
        status: 'approved',
        year: '2026',
        program: 'Software Engineering',
        discipline: 'AI',
        sort: 'title',
        direction: 'asc',
        page: 2,
        pageSize: 25,
      });
    });

    it('rejects partial or invalid numeric strings for page and pageSize strictly', () => {
      expect(parseProjectListQuery({ page: '2abc' }).page).toBe(1);
      expect(parseProjectListQuery({ page: '1.5' }).page).toBe(1);
      expect(parseProjectListQuery({ page: '+2' }).page).toBe(1);
      expect(parseProjectListQuery({ page: ' 3junk' }).page).toBe(1);
      expect(parseProjectListQuery({ page: '-5' }).page).toBe(1);
      expect(parseProjectListQuery({ page: '0' }).page).toBe(1);

      expect(parseProjectListQuery({ pageSize: '10records' }).pageSize).toBe(10);
      expect(parseProjectListQuery({ pageSize: '25.5' }).pageSize).toBe(10);
      expect(parseProjectListQuery({ pageSize: '100' }).pageSize).toBe(10);
    });

    it('falls back to page 1 for page inputs exceeding MAX_PROJECT_INDEX_PAGE or Number.MAX_SAFE_INTEGER', () => {
      expect(parseProjectListQuery({ page: '1000001' }).page).toBe(1);
      expect(parseProjectListQuery({ page: '99999999999999999999' }).page).toBe(1);
      expect(parseProjectListQuery({ page: String(MAX_PROJECT_INDEX_PAGE) }).page).toBe(MAX_PROJECT_INDEX_PAGE);
    });

    it('accepts valid pageSize choices 10, 25, 50 only', () => {
      expect(parseProjectListQuery({ pageSize: '10' }).pageSize).toBe(10);
      expect(parseProjectListQuery({ pageSize: '25' }).pageSize).toBe(25);
      expect(parseProjectListQuery({ pageSize: '50' }).pageSize).toBe(50);
      expect(parseProjectListQuery({ pageSize: '15' }).pageSize).toBe(10);
    });
  });
});
