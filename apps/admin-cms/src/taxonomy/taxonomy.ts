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

export interface TaxonomyEntry {
  id: string;
  name: string;
  usageCount: number;
}

export type TaxonomyActionCode =
  | 'CREATED'
  | 'INVALID_INPUT'
  | 'DUPLICATE'
  | 'PERSISTENCE_FAILED';

export type TaxonomyActionResult = {
  ok: true;
  code: 'CREATED';
  entry: Pick<TaxonomyEntry, 'id' | 'name'>;
} | {
  ok: false;
  code: Exclude<TaxonomyActionCode, 'CREATED'>;
  message: string;
};

export interface TaxonomyGateway {
  create(kind: TaxonomyKind, name: string): Promise<{ id: string; name: string }>;
}

export class TaxonomyConflictError extends Error {
  constructor() {
    super('TAXONOMY_DUPLICATE');
  }
}

export function taxonomyMessage(code: Exclude<TaxonomyActionCode, 'CREATED'>): string {
  switch (code) {
    case 'INVALID_INPUT': return 'Enter a valid catalogue name.';
    case 'DUPLICATE': return 'That catalogue value already exists.';
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

export function parseTaxonomyKind(value: string): TaxonomyKind | null {
  return TAXONOMY_KINDS.includes(value as TaxonomyKind) ? value as TaxonomyKind : null;
}
