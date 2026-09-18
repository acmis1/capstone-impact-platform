import { z } from 'zod';
import { postgresUuidSchema } from './projectMetadata';
import { SOFT_DELETE_DECISION_CODES } from './projectSoftDelete';

// Pure response validation: this module performs no database or network operations.
const publicIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u);
const privateStatus = z.enum(['draft', 'changes_requested']);
const refusalCodes = new Set<string>([
  'PERMISSION_DENIED', 'VALIDATION_FAILED', 'INVALID_LAYOUT_CONFIG', 'PROJECT_NOT_FOUND',
  'STALE_VERSION', 'LAYOUT_STATUS_INELIGIBLE', 'LAYOUT_PUBLIC_OR_REMOVAL_ACTIVE',
  'PUBLICATION_OR_REMOVAL_PENDING', 'RECIPE_NOT_FOUND', 'RECIPE_VERSION_INACTIVE_OR_CHANGED',
  'LAYOUT_EVIDENCE_INVALID', 'LAYOUT_EVIDENCE_AMBIGUOUS',
  ...SOFT_DELETE_DECISION_CODES.filter(code => code !== 'ELIGIBLE').map(code => `LAYOUT_EVIDENCE_${code}`),
]);

const resultSchema = z.union([
  z.object({
    resultCode: z.literal('UPDATED'), publicId: publicIdSchema, status: privateStatus,
    updatedAt: z.string().datetime({ offset: true }), auditRecordId: postgresUuidSchema,
    revokedActivePreviewCount: z.number().int().min(0).max(1),
  }).strict(),
  z.object({ resultCode: z.literal('UNCHANGED'), publicId: publicIdSchema, status: privateStatus }).strict(),
  z.object({
    resultCode: z.string().refine(code => refusalCodes.has(code)),
    publicId: publicIdSchema.optional(), status: z.string().max(40).optional(),
    reason: z.string().max(1000).optional(),
  }).strict(),
]);

export function parseProjectLayoutMaintenanceResponse(input: unknown, expectedPublicId: string) {
  const parsed = resultSchema.safeParse(input);
  if (!parsed.success) throw new Error('Project layout response is invalid.');
  if (parsed.data.publicId !== undefined && parsed.data.publicId !== expectedPublicId) {
    throw new Error('Project layout response does not match the requested project.');
  }
  return parsed.data;
}
