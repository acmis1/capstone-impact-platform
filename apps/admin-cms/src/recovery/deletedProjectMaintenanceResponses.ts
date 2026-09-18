import { z } from 'zod';
import { postgresUuidSchema } from '../projects/projectMetadata';
import { SOFT_DELETE_DECISION_CODES } from '../projects/projectSoftDelete';

const publicId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u);
const instant = z.string().datetime({ offset: true });
const nullableInstant = instant.nullable();
const text = z.string().max(20_000).nullable();
const count = z.number().int().nonnegative();
const status = z.enum(['draft', 'submitted', 'in_review', 'changes_requested', 'approved', 'published', 'archived', 'deleted']);
const recoveryCodes = new Set<string>([
  'READY_FOR_RECOVERY', 'PROJECT_NOT_FOUND', 'DELETE_STATE_AMBIGUOUS', 'NOT_DELETED',
  'RECOVERY_EVIDENCE_REQUIRED', 'RECOVERY_EVIDENCE_AMBIGUOUS',
  ...SOFT_DELETE_DECISION_CODES.filter(code => code !== 'ELIGIBLE').map(code => `RECOVERY_${code}`),
]);
const recovery = z.object({
  code: z.string().refine(code => recoveryCodes.has(code)), reason: z.string().min(1).max(1000),
  softDeleteAuditId: postgresUuidSchema.optional(),
}).strict().refine(value => value.code !== 'READY_FOR_RECOVERY' || Boolean(value.softDeleteAuditId));
const projectRow = z.object({
  publicId, title: z.string().max(1000), status, deletedAt: nullableInstant,
  updatedAt: nullableInstant, createdAt: nullableInstant, recovery,
}).strict().refine(row => row.recovery.code !== 'READY_FOR_RECOVERY'
  || (row.status === 'deleted' && row.deletedAt !== null && row.updatedAt !== null));
const listSchema = z.object({
  items: z.array(projectRow).max(50), total: count, page: z.number().int().min(1).max(100_000),
  pageSize: z.union([z.literal(20), z.literal(50)]), pageCount: count,
}).strict().refine(value => value.pageCount === Math.ceil(value.total / value.pageSize)
  && value.items.length === Math.min(value.pageSize, Math.max(0, value.total - (value.page - 1) * value.pageSize))
  && new Set(value.items.map(item => item.publicId)).size === value.items.length);

const media = z.object({
  id: postgresUuidSchema, assetType: z.string().max(100), fileName: text,
  storageBucket: text, storagePath: text, mimeType: text, fileSizeBytes: count.nullable(),
  isPublicApproved: z.boolean().nullable(), publicUrl: text, publicStorageBucket: text,
  publicStoragePath: text, createdAt: nullableInstant,
}).strict();
const approval = z.object({
  id: postgresUuidSchema, action: z.string().min(1).max(100), fromStatus: status.nullable(),
  toStatus: status.nullable(), comments: text, createdAt: nullableInstant,
  actorFullName: text, actorEmail: text, eventDetails: z.unknown().nullable(),
}).strict();
const preview = z.object({
  id: postgresUuidSchema, status: z.enum(['active', 'revoked']), createdAt: instant,
  expiresAt: instant, revokedAt: nullableInstant, revokedBy: postgresUuidSchema.nullable(),
}).strict();
const feed = z.object({
  id: postgresUuidSchema, kind: z.string().min(1).max(100), state: z.string().min(1).max(100),
  createdAt: instant, completedAt: nullableInstant, finalizedAt: nullableInstant, failureCode: text,
}).strict();
const detailSchema = z.object({
  resultCode: z.literal('FOUND'),
  project: z.object({
    id: postgresUuidSchema, publicId, title: z.string().max(1000), status,
    deletedAt: nullableInstant, updatedAt: nullableInstant, createdAt: nullableInstant,
    summary: text, background: text, solution: text, year: z.number().int().nullable(),
    program: text, discipline: text, industry: text, groupName: text,
  }).strict(),
  recovery, media: z.array(media).max(10_000), approvalHistory: z.array(approval).max(10_000),
  participantPreviews: z.array(preview).max(10_000), feedHistory: z.array(feed).max(10_000),
}).strict().refine(value => value.recovery.code !== 'READY_FOR_RECOVERY'
  || (value.project.status === 'deleted' && value.project.deletedAt !== null && value.project.updatedAt !== null));

const recoverSchema = z.union([
  z.object({
    resultCode: z.literal('RECOVERED'), publicId, status: z.literal('draft'),
    updatedAt: instant, auditRecordId: postgresUuidSchema, rearmedPublicMappingRows: count,
  }).strict(),
  z.object({ resultCode: z.literal('ALREADY_RECOVERED'), publicId, status: status.exclude(['deleted']) }).strict(),
  z.object({
    resultCode: z.string().refine(code => ['PERMISSION_DENIED', 'VALIDATION_FAILED', 'PROJECT_NOT_FOUND',
      'RECOVERY_NOT_DELETED', 'STALE_DELETED_TIMESTAMP', 'STALE_VERSION'].includes(code)
      || (recoveryCodes.has(code) && code !== 'READY_FOR_RECOVERY')),
    code: z.string().optional(), reason: z.string().max(1000).optional(), softDeleteAuditId: postgresUuidSchema.optional(),
  }).strict().refine(value => value.code === undefined || value.code === value.resultCode),
]);

function checked<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error('Deleted project response is invalid.');
  return parsed.data;
}

export function parseDeletedProjectListResponse(input: unknown, page: number, pageSize: number) {
  const result = checked(listSchema, input);
  if (result.page !== page || result.pageSize !== pageSize) throw new Error('Deleted project response page mismatch.');
  return result;
}

export function parseDeletedProjectDetailResponse(input: unknown, expectedPublicId: string) {
  if (z.object({ resultCode: z.literal('PROJECT_NOT_FOUND') }).strict().safeParse(input).success) return null;
  const result = checked(detailSchema, input);
  if (result.project.publicId !== expectedPublicId) throw new Error('Deleted project detail target mismatch.');
  return result;
}

export function parseDeletedProjectRecoveryResponse(input: unknown, expectedPublicId: string) {
  const result = checked(recoverSchema, input);
  if ('publicId' in result && result.publicId !== expectedPublicId) throw new Error('Deleted project recovery target mismatch.');
  return result;
}
