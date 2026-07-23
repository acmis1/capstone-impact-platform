import { describe, it, expect } from 'vitest';
import { parseProjectListQuery, normalizeSearchInput } from './projectQuery';

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

    it('strips PostgREST special operator characters', () => {
      expect(normalizeSearchInput('title:eq.test(123),select*%20')).toBe('title eq test 123 select 20');
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

    it('ignores invalid status and sort values safely', () => {
      const params = {
        status: 'invalid_status_value',
        sort: 'unsupported_column; DROP TABLE projects;',
        direction: 'invalid_dir',
        page: '-5',
        pageSize: '100',
      };

      const result = parseProjectListQuery(params);
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

    it('accepts valid pageSize choices 10, 25, 50 only', () => {
      expect(parseProjectListQuery({ pageSize: '10' }).pageSize).toBe(10);
      expect(parseProjectListQuery({ pageSize: '25' }).pageSize).toBe(25);
      expect(parseProjectListQuery({ pageSize: '50' }).pageSize).toBe(50);
      expect(parseProjectListQuery({ pageSize: '15' }).pageSize).toBe(10);
    });
  });
});
