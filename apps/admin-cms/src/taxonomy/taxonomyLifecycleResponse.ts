import { z } from 'zod';
import { postgresUuidSchema } from '../projects/projectMetadata';

const resultSchema = z.union([
  z.object({
    resultCode: z.enum(['RETIRED', 'REACTIVATED', 'RENAMED', 'UNCHANGED']),
    id: postgresUuidSchema, name: z.string().min(1).max(120),
    retiredAt: z.string().datetime({ offset: true }).nullable(), lifecycleVersion: z.number().int().min(1),
  }).strict(),
  z.object({
    resultCode: z.enum(['PERMISSION_DENIED', 'VALIDATION_FAILED', 'NOT_FOUND', 'STALE_VERSION', 'REFERENCED_RENAME_BLOCKED', 'DUPLICATE_NAME', 'BUSY']),
    lifecycleVersion: z.number().int().min(1).optional(), referenceCount: z.number().int().min(1).optional(),
  }).strict(),
]);

export function parseTaxonomyLifecycleResponse(input: unknown, expected: {
  taxonomyId: string; action: 'retire' | 'reactivate' | 'rename'; expectedLifecycleVersion: number; name?: string;
}) {
  const parsed = resultSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid catalogue lifecycle response.');
  const result = parsed.data;
  if ('id' in result) {
    const actionCode = { retire: 'RETIRED', reactivate: 'REACTIVATED', rename: 'RENAMED' }[expected.action];
    if (result.id !== expected.taxonomyId || (result.resultCode !== 'UNCHANGED' && result.resultCode !== actionCode)
      || result.lifecycleVersion !== expected.expectedLifecycleVersion + (result.resultCode === 'UNCHANGED' ? 0 : 1)
      || (expected.action === 'retire' && result.retiredAt === null)
      || (expected.action === 'reactivate' && result.retiredAt !== null)
      || (expected.action === 'rename' && result.name !== expected.name?.trim())) throw new Error('Catalogue lifecycle response does not match the request.');
  }
  return result;
}
