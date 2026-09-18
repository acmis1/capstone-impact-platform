import { z } from 'zod';
import type { StaffDirectoryEntry } from './staffProvisioningRepository';

export const STAFF_DIRECTORY_PAGE_SIZE = 20;
const querySchema = z.object({ q: z.string().trim().max(100).regex(/^[^\u0000-\u001f\u007f]*$/).default(''), status: z.enum(['', 'active', 'pending_activation', 'deactivated']).default(''), page: z.coerce.number().int().min(1).max(10000).default(1) });
export type StaffDirectoryQuery = z.infer<typeof querySchema>;
export function parseStaffDirectoryQuery(value: unknown): StaffDirectoryQuery { return querySchema.parse(value); }
export function selectStaffDirectoryPage(staff: StaffDirectoryEntry[], query: StaffDirectoryQuery) {
  const search = query.q.toLocaleLowerCase('en-AU');
  const filtered = staff.filter(entry => (!query.status || entry.status === query.status) && (!search || [entry.fullName, entry.email].some(value => value.toLocaleLowerCase('en-AU').includes(search))));
  const start = (query.page - 1) * STAFF_DIRECTORY_PAGE_SIZE;
  return { staff: filtered.slice(start, start + STAFF_DIRECTORY_PAGE_SIZE), matching: filtered.length, pages: Math.max(1, Math.ceil(filtered.length / STAFF_DIRECTORY_PAGE_SIZE)) };
}
export function staffDirectoryHref(query: StaffDirectoryQuery, page: number): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.status) params.set('status', query.status);
  if (page > 1) params.set('page', String(page));
  return '/admin/staff' + (params.size ? '?' + params : '');
}
