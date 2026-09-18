import { z } from 'zod';
const day = z.string().refine(value => value === '' || (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value), 'Use a real calendar date.');
const filters = z.object({
  project: z.string().max(100).regex(/^$|^[A-Za-z0-9_-]+$/).default(''),
  operation: z.enum(['', 'baseline', 'publication', 'removal', 'rollback']).default(''),
  from: day.default(''),
  to: day.default(''),
}).refine(value => !value.from || !value.to || value.from <= value.to, 'End date must follow start date.');
export type PublicFeedHistoryFilters = z.infer<typeof filters>;
export function parsePublicFeedHistoryFilters(input: unknown): PublicFeedHistoryFilters { return filters.parse(input); }
export function publicFeedHistoryHref(page: number, filter?: PublicFeedHistoryFilters, version?: number): string {
  const params = new URLSearchParams({ page: String(page) });
  if (filter) for (const key of ['project', 'operation', 'from', 'to'] as const) if (filter[key]) params.set(key, filter[key]);
  if (version !== undefined) params.set('version', String(version));
  return '/admin/public-feed?' + params;
}
