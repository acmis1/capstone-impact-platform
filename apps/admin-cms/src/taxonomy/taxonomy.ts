import { z } from 'zod';
import { parseTaxonomyLifecycleResponse } from './taxonomyLifecycleResponse';

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
  retiredAt?: string | null;
  lifecycleVersion?: number;
}

export type TaxonomyActionCode =
  | 'CREATED'
  | 'RETIRED'
  | 'REACTIVATED'
  | 'RENAMED'
  | 'UNCHANGED'
  | 'INVALID_INPUT'
  | 'DUPLICATE'
  | 'STALE_VERSION'
  | 'BUSY'
  | 'REFERENCED_RENAME_BLOCKED'
  | 'PERMISSION_DENIED'
  | 'PERSISTENCE_FAILED';

export type TaxonomyActionResult = {
  ok: true;
  code: 'CREATED' | 'RETIRED' | 'REACTIVATED' | 'RENAMED' | 'UNCHANGED';
  entry: Pick<TaxonomyEntry, 'id' | 'name' | 'retiredAt' | 'lifecycleVersion'>;
} | {
  ok: false;
  code: Exclude<TaxonomyActionCode, 'CREATED' | 'RETIRED' | 'REACTIVATED' | 'RENAMED' | 'UNCHANGED'>;
  message: string;
};

export interface TaxonomyGateway {
  create(kind: TaxonomyKind, name: string): Promise<{ id: string; name: string }>;
  lifecycle?(input: {
    kind: TaxonomyKind;
    taxonomyId: string;
    action: 'retire' | 'reactivate' | 'rename';
    name?: string;
    expectedLifecycleVersion: number;
    actorAdminId: string;
  }): Promise<{ resultCode: string; id?: string; name?: string; retiredAt?: string | null; lifecycleVersion?: number; referenceCount?: number }>;
}

export class TaxonomyConflictError extends Error {
  constructor() {
    super('TAXONOMY_DUPLICATE');
  }
}

export function taxonomyMessage(code: Exclude<TaxonomyActionCode, 'CREATED' | 'RETIRED' | 'REACTIVATED' | 'RENAMED' | 'UNCHANGED'>): string {
  switch (code) {
    case 'INVALID_INPUT': return 'Enter a valid catalogue name.';
    case 'DUPLICATE': return 'That catalogue value already exists.';
    case 'BUSY': return 'Project data is being updated. Reload the catalogue and try again.';
    case 'STALE_VERSION': return 'This catalogue value changed in another session. Reload before trying again.';
    case 'REFERENCED_RENAME_BLOCKED': return 'Referenced values cannot be renamed. Create the corrected value and retire the old one.';
    case 'PERMISSION_DENIED': return 'Your account cannot manage catalogue lifecycle.';
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

const taxonomyLifecycleInputSchema = z.object({
  action: z.enum(['retire', 'reactivate', 'rename']),
  id: z.string().uuid(),
  expectedLifecycleVersion: z.number().int().min(1),
  name: taxonomyNameSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.action === 'rename' && value.name === undefined) {
    context.addIssue({ code: 'custom', path: ['name'], message: 'A replacement name is required.' });
  }
});

export async function transitionTaxonomyEntry(
  gateway: TaxonomyGateway,
  kind: TaxonomyKind,
  actorAdminId: string,
  rawInput: unknown,
): Promise<TaxonomyActionResult> {
  const parsed = taxonomyLifecycleInputSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT', message: taxonomyMessage('INVALID_INPUT') };
  if (!gateway.lifecycle) return { ok: false, code: 'PERSISTENCE_FAILED', message: taxonomyMessage('PERSISTENCE_FAILED') };
  try {
    const rawResult = await gateway.lifecycle({
      kind,
      taxonomyId: parsed.data.id,
      action: parsed.data.action,
      name: parsed.data.name,
      expectedLifecycleVersion: parsed.data.expectedLifecycleVersion,
      actorAdminId,
    });
    const result = parseTaxonomyLifecycleResponse(rawResult, { taxonomyId: parsed.data.id, action: parsed.data.action, expectedLifecycleVersion: parsed.data.expectedLifecycleVersion, name: parsed.data.name });
    if ('id' in result) {
      return { ok: true, code: result.resultCode as 'RETIRED' | 'REACTIVATED' | 'RENAMED' | 'UNCHANGED', entry: { id: result.id, name: result.name, retiredAt: result.retiredAt, lifecycleVersion: result.lifecycleVersion } };
    }
    const code = result.resultCode === 'BUSY' ? 'BUSY'
      : result.resultCode === 'DUPLICATE_NAME' ? 'DUPLICATE'
      : result.resultCode === 'REFERENCED_RENAME_BLOCKED' ? 'REFERENCED_RENAME_BLOCKED'
        : result.resultCode === 'STALE_VERSION' ? 'STALE_VERSION'
          : result.resultCode === 'PERMISSION_DENIED' ? 'PERMISSION_DENIED' : 'PERSISTENCE_FAILED';
    return { ok: false, code, message: taxonomyMessage(code) };
  } catch {
    return { ok: false, code: 'PERSISTENCE_FAILED', message: taxonomyMessage('PERSISTENCE_FAILED') };
  }
}
