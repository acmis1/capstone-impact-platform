import { z } from 'zod';

export const TAXONOMY_KINDS = ['program', 'discipline', 'industryCategory'] as const;
export type TaxonomyKind = typeof TAXONOMY_KINDS[number];

export const TAXONOMY_LABELS: Record<TaxonomyKind, string> = {
  program: 'Programs',
  discipline: 'Disciplines',
  industryCategory: 'Industry categories',
};

export const taxonomyNameSchema = z.string()
  .trim()
  .min(1, 'Enter a name.')
  .max(120, 'Names must be 120 characters or fewer.');

export const taxonomyCreateInputSchema = z.object({
  name: taxonomyNameSchema,
}).strict();

export const taxonomyRemoveInputSchema = z.object({
  id: z.string().uuid(),
}).strict();

export interface TaxonomyEntry {
  id: string;
  name: string;
  usageCount: number;
}

export type TaxonomyActionCode =
  | 'CREATED'
  | 'REMOVED'
  | 'INVALID_INPUT'
  | 'DUPLICATE'
  | 'IN_USE'
  | 'NOT_FOUND'
  | 'PERSISTENCE_FAILED';

export type TaxonomyActionResult = {
  ok: true;
  code: 'CREATED' | 'REMOVED';
  entry?: Pick<TaxonomyEntry, 'id' | 'name'>;
} | {
  ok: false;
  code: Exclude<TaxonomyActionCode, 'CREATED' | 'REMOVED'>;
  message: string;
};

export interface TaxonomyGateway {
  create(kind: TaxonomyKind, name: string): Promise<{ id: string; name: string }>;
  isReferenced(kind: TaxonomyKind, id: string): Promise<boolean>;
  remove(kind: TaxonomyKind, id: string): Promise<boolean>;
}

export class TaxonomyConflictError extends Error {
  constructor() {
    super('TAXONOMY_DUPLICATE');
  }
}

export function taxonomyMessage(code: Exclude<TaxonomyActionCode, 'CREATED' | 'REMOVED'>): string {
  switch (code) {
    case 'INVALID_INPUT': return 'Enter a valid catalogue name.';
    case 'DUPLICATE': return 'That catalogue value already exists.';
    case 'IN_USE': return 'This value is used by one or more projects and cannot be removed.';
    case 'NOT_FOUND': return 'This catalogue value no longer exists.';
    case 'PERSISTENCE_FAILED': return 'The catalogue change could not be completed. Try again.';
  }
}

export async function createTaxonomyEntry(
  gateway: TaxonomyGateway,
  kind: TaxonomyKind,
  rawInput: unknown,
): Promise<TaxonomyActionResult> {
  const parsed = taxonomyCreateInputSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT', message: taxonomyMessage('INVALID_INPUT') };

  try {
    const entry = await gateway.create(kind, parsed.data.name);
    return { ok: true, code: 'CREATED', entry };
  } catch (error) {
    if (error instanceof TaxonomyConflictError) {
      return { ok: false, code: 'DUPLICATE', message: taxonomyMessage('DUPLICATE') };
    }
    return { ok: false, code: 'PERSISTENCE_FAILED', message: taxonomyMessage('PERSISTENCE_FAILED') };
  }
}

export async function removeTaxonomyEntry(
  gateway: TaxonomyGateway,
  kind: TaxonomyKind,
  rawInput: unknown,
): Promise<TaxonomyActionResult> {
  const parsed = taxonomyRemoveInputSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT', message: taxonomyMessage('INVALID_INPUT') };

  try {
    // The database's historical mapping foreign keys cascade. The route therefore refuses every
    // referenced row before it ever issues DELETE, preserving both project mappings and scalar
    // compatibility names. This surface intentionally has no rename operation for the same reason.
    if (await gateway.isReferenced(kind, parsed.data.id)) {
      return { ok: false, code: 'IN_USE', message: taxonomyMessage('IN_USE') };
    }
    const removed = await gateway.remove(kind, parsed.data.id);
    return removed
      ? { ok: true, code: 'REMOVED' }
      : { ok: false, code: 'NOT_FOUND', message: taxonomyMessage('NOT_FOUND') };
  } catch {
    return { ok: false, code: 'PERSISTENCE_FAILED', message: taxonomyMessage('PERSISTENCE_FAILED') };
  }
}

export function parseTaxonomyKind(value: string): TaxonomyKind | null {
  return TAXONOMY_KINDS.includes(value as TaxonomyKind) ? value as TaxonomyKind : null;
}
