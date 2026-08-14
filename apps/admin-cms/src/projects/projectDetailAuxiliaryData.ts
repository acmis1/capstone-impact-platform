import type {
  ParticipantPreviewCorrectionResolutionStatus,
  ParticipantPreviewResponseState,
} from '../domain/participantPreview';
import type { PublicationReadinessResult } from '../domain/publicationReadiness';
import type { ParticipantPreviewNotificationView } from '../notifications/participantPreviewNotification';
import type { ParticipantPreviewReminderView } from '../reminders/participantPreviewReminder';
import { ParticipantPreviewExecutionError } from '../repositories/ParticipantPreviewRepository';
import { postgresUuidSchema } from './projectMetadata';
import { z } from 'zod';

export const PROJECT_AUDIT_HISTORY_SELECT = 'id,admin_id,action_taken,from_status,to_status,comments,created_at,actor_full_name_snapshot,actor_email_snapshot,event_details,admin_users!approval_records_admin_id_fkey(full_name,email)';

const metadataFieldSchema = z.enum([
  'title',
  'summary',
  'background',
  'solution',
  'posterText',
  'accessibilityText',
  'year',
  'program',
  'disciplines',
  'industryCategories',
]);

const lookupSnapshotSchema = z.object({
  id: postgresUuidSchema,
  name: z.string().nullable(),
}).strict();

const metadataStateSchema = z.object({
  title: z.string().optional(),
  summary: z.string().optional(),
  background: z.string().optional(),
  solution: z.string().optional(),
  posterText: z.string().optional(),
  accessibilityText: z.string().optional(),
  year: z.number().optional(),
  program: lookupSnapshotSchema.optional(),
  disciplines: z.array(lookupSnapshotSchema).optional(),
  industryCategories: z.array(lookupSnapshotSchema).optional(),
}).strict();

const metadataEventDetailsSchema = z.object({
  version: z.literal(1),
  type: z.literal('project_metadata'),
  changedFields: z.array(metadataFieldSchema).min(1)
    .refine((fields) => new Set(fields).size === fields.length, 'changedFields must be unique'),
  before: metadataStateSchema,
  after: metadataStateSchema,
}).strict().superRefine((details, context) => {
  for (const field of details.changedFields) {
    if (!(field in details.before)) {
      context.addIssue({ code: 'custom', path: ['before', field], message: `Missing before.${field}` });
    }
    if (!(field in details.after)) {
      context.addIssue({ code: 'custom', path: ['after', field], message: `Missing after.${field}` });
    }
  }
});

/**
 * Media-level accessibility edits carry their own event_details contract rather than being squeezed
 * into `project_metadata`: they change a specific media asset, not a project column, and the
 * history needs to say which asset truthfully. Both contracts are written under the existing
 * `update_metadata` action, which every current reader already understands.
 */
const mediaAccessibilityEventDetailsSchema = z.object({
  version: z.literal(1),
  type: z.literal('media_accessibility'),
  mediaAssetId: postgresUuidSchema,
  assetType: z.literal('snapshot_image'),
  changedFields: z.array(z.literal('snapshotAltText')).min(1)
    .refine((fields) => new Set(fields).size === fields.length, 'changedFields must be unique'),
  // `before` is nullable: the first time staff describe a snapshot, there was genuinely nothing
  // there before, and recording that as an empty string would misstate the history.
  before: z.object({ snapshotAltText: z.string().nullable() }).strict(),
  after: z.object({ snapshotAltText: z.string() }).strict(),
}).strict();

const auditHistoryRowSchema = z.object({
  id: postgresUuidSchema,
  admin_id: postgresUuidSchema.nullable(),
  action_taken: z.string().min(1),
  from_status: z.string().nullable(),
  to_status: z.string().nullable(),
  comments: z.string().nullable(),
  created_at: z.string().nullable(),
  actor_full_name_snapshot: z.string().nullable(),
  actor_email_snapshot: z.string().nullable(),
  event_details: z.unknown().nullable(),
  admin_users: z.object({
    full_name: z.string().nullable(),
    email: z.string(),
  }).strict().nullable(),
}).strict();

export type ProjectMetadataEventDetails = z.infer<typeof metadataEventDetailsSchema>;
export type MediaAccessibilityEventDetails = z.infer<typeof mediaAccessibilityEventDetailsSchema>;

export interface AuditHistoryView {
  id: string;
  action: string;
  timestamp: string;
  fromStatus: string | null;
  toStatus: string | null;
  comments: string | null;
  actorFullName: string;
  actorEmail: string | null;
  metadataEventDetails: ProjectMetadataEventDetails | null;
  /** Populated instead of `metadataEventDetails` when the edit changed media accessibility. */
  mediaAccessibilityEventDetails: MediaAccessibilityEventDetails | null;
}

function nonEmptyString(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function parseAuditHistoryRow(input: unknown): AuditHistoryView {
  const row = auditHistoryRowSchema.parse(input);
  let metadataEventDetails: ProjectMetadataEventDetails | null = null;
  let mediaAccessibilityEventDetails: MediaAccessibilityEventDetails | null = null;
  if (row.event_details) {
    // Discriminated on the stored `type`, so a media-accessibility record is never mistaken for a
    // malformed project-metadata one, and an unrecognised shape still degrades safely.
    const metadata = metadataEventDetailsSchema.safeParse(row.event_details);
    const mediaAccessibility = mediaAccessibilityEventDetailsSchema.safeParse(row.event_details);
    if (metadata.success) {
      metadataEventDetails = metadata.data;
    } else if (mediaAccessibility.success) {
      mediaAccessibilityEventDetails = mediaAccessibility.data;
    } else {
      console.warn('[AuditHistory] Malformed event_details, degrading safely');
    }
  }

  const snapshotName = nonEmptyString(row.actor_full_name_snapshot);
  const fallbackName = nonEmptyString(row.admin_users?.full_name ?? null);
  const snapshotEmail = nonEmptyString(row.actor_email_snapshot);
  const fallbackEmail = nonEmptyString(row.admin_users?.email ?? null);

  return {
    id: row.id,
    action: row.action_taken,
    timestamp: row.created_at ?? '',
    fromStatus: row.from_status,
    toStatus: row.to_status,
    comments: row.comments,
    actorFullName: snapshotName ?? fallbackName ?? 'Unknown staff member',
    actorEmail: snapshotEmail ?? fallbackEmail,
    metadataEventDetails,
    mediaAccessibilityEventDetails,
  };
}

export interface ProjectDetailPreviewState {
  activePreview: { createdAt: string; expiresAt: string } | null;
  responseState: ParticipantPreviewResponseState;
  /**
   * Delivery history for the current active preview, or null when its link was generated without
   * email — a state the panel must state plainly rather than offer to "send later", because the
   * one-time credential no longer exists.
   */
  notification: ParticipantPreviewNotificationView | null;
  /** Staff-facing reminder history across exact preview versions for this project. */
  reminders: ParticipantPreviewReminderView[];
}

export interface ProjectDetailAuxiliaryData<TProject> {
  project: TProject;
  auditRecords: AuditHistoryView[] | null;
  previewState: ProjectDetailPreviewState;
  previewStateAvailable: boolean;
  resolutionStatus: ParticipantPreviewCorrectionResolutionStatus | null;
  resolutionStatusAvailable: boolean;
  publicationReadiness: PublicationReadinessResult | null;
  publicationActionsAvailable: boolean;
}

export interface ProjectDetailAuxiliaryLoaders {
  loadAuditRecords(): Promise<AuditHistoryView[]>;
  loadPreviewState(): Promise<ProjectDetailPreviewState>;
  loadResolutionStatus(): Promise<ParticipantPreviewCorrectionResolutionStatus | null>;
  loadPublicationReadiness(): Promise<PublicationReadinessResult>;
}

export type ProjectDetailSubsystem =
  | 'audit history'
  | 'participant preview'
  | 'correction resolution'
  | 'publication readiness';

export type ProjectDetailFailureLogger = (subsystem: ProjectDetailSubsystem, category: string) => void;

export class ProjectDetailAuxiliaryReadError extends Error {
  constructor(readonly category: 'PROJECT_ID_UNAVAILABLE' | 'QUERY_FAILED' | 'INVALID_RESPONSE') {
    super(category);
    this.name = 'ProjectDetailAuxiliaryReadError';
  }
}

export function projectDetailFailureCategory(error: unknown): string {
  if (error instanceof ParticipantPreviewExecutionError) return error.code;
  if (error instanceof ProjectDetailAuxiliaryReadError) return error.category;
  return 'UNEXPECTED_FAILURE';
}

const defaultLogger: ProjectDetailFailureLogger = (subsystem, category) => {
  console.error(`[Project detail: ${subsystem} load failure]`, category);
};

async function settle<T>(
  subsystem: ProjectDetailSubsystem,
  loader: () => Promise<T>,
  logFailure: ProjectDetailFailureLogger,
): Promise<{ available: true; value: T } | { available: false; value: null }> {
  try {
    return { available: true, value: await loader() };
  } catch (error: unknown) {
    logFailure(subsystem, projectDetailFailureCategory(error));
    return { available: false, value: null };
  }
}

/**
 * Loads project-detail secondary data independently. None of these reads may erase an already
 * authenticated, successfully loaded base project. Availability flags prevent valid empty
 * business states from being confused with infrastructure failures.
 */
export async function loadProjectDetailAuxiliaryData<TProject>(
  project: TProject,
  loaders: ProjectDetailAuxiliaryLoaders,
  logFailure: ProjectDetailFailureLogger = defaultLogger,
): Promise<ProjectDetailAuxiliaryData<TProject>> {
  const [audit, preview, resolution, readiness] = await Promise.all([
    settle('audit history', loaders.loadAuditRecords, logFailure),
    settle('participant preview', loaders.loadPreviewState, logFailure),
    settle('correction resolution', loaders.loadResolutionStatus, logFailure),
    settle('publication readiness', loaders.loadPublicationReadiness, logFailure),
  ]);

  if (readiness.available && readiness.value.resultCode === 'READINESS_UNAVAILABLE') {
    logFailure('publication readiness', 'READINESS_UNAVAILABLE');
  }

  const publicationReadiness = readiness.available ? readiness.value : null;
  const publicationActionsAvailable =
    preview.available &&
    resolution.available &&
    publicationReadiness?.ready === true &&
    publicationReadiness.resultCode === 'READY';
  const verifiedPublicationReadiness = preview.available && resolution.available
    ? publicationReadiness
    : null;

  return {
    project,
    auditRecords: audit.available ? audit.value : null,
    previewState: preview.available
      ? preview.value
      : { activePreview: null, responseState: { type: 'unresponded' }, notification: null, reminders: [] },
    previewStateAvailable: preview.available,
    resolutionStatus: resolution.available ? resolution.value : null,
    resolutionStatusAvailable: resolution.available,
    publicationReadiness: verifiedPublicationReadiness,
    publicationActionsAvailable,
  };
}
