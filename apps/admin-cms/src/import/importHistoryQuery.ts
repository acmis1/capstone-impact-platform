import { z } from 'zod';

export const IMPORT_HISTORY_PAGE_SIZE = 20;
export const IMPORT_HISTORY_STATUSES = ['completed', 'metadata_staged', 'processing', 'running', 'failed'] as const;
const schema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  q: z.string().trim().max(100).regex(/^[^\u0000-\u001f\u007f]*$/).default(''),
  year: z.string().regex(/^$|^(19|20|21)\d{2}$/).default(''),
  status: z.union([z.literal(''), z.enum(IMPORT_HISTORY_STATUSES)]).default(''),
});
export type ImportHistoryQuery = z.infer<typeof schema>;

export function parseImportHistoryQuery(input: Record<string, unknown>): ImportHistoryQuery {
  return schema.parse(input);
}

export function importHistoryHref(query: ImportHistoryQuery, page: number): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.year) params.set('year', query.year);
  if (query.status) params.set('status', query.status);
  if (page > 1) params.set('page', String(page));
  return '/admin/imports' + (params.size ? '?' + params : '');
}
