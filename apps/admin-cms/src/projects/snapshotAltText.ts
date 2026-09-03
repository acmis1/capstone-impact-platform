import { z } from 'zod';
import { ACCESSIBLE_CONTENT_LIMITS } from '../domain/accessibleContent';

/**
 * Legacy compatibility contract for snapshot image text alternatives. The active workflow
 * replaces project-team-authored source packages; staff cannot edit this content directly.
 *
 * The value is project-team-authored. Nothing here derives it from the filename, the project title, the
 * poster accessibility text, OCR, or any AI service, and nothing judges the prose: the only rules
 * are that it is present after trimming and within the shared technical ceiling. An oversized value
 * is rejected rather than truncated, so the project team's supplied wording remains intact.
 */
export const snapshotAltTextInputSchema = z.object({
  publicId: z.string().trim().min(1),

  /**
   * Exact snapshot media row being edited.
   * The database still verifies that it belongs to publicId and is a snapshot_image.
   */
  mediaAssetId: z.string().uuid(),

  snapshotAltText: z.string()
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, 'Snapshot image alt text is required.')
    .refine(
      (value) => value.length <= ACCESSIBLE_CONTENT_LIMITS.snapshotAltText,
      `Must be ${ACCESSIBLE_CONTENT_LIMITS.snapshotAltText} characters or fewer.`,
    ),
  /**
   * The project's `updated_at` as last read by this editor. Shared with the metadata editor on
   * purpose: both act on the same project detail view, so a stale tab in either surface must lose
   * rather than silently overwrite the other's work.
   */
  expectedUpdatedAt: z.string().refine(
    (value) => !Number.isNaN(Date.parse(value)),
    'Expected version must be a timestamp.',
  ),
}).strict();

export type SnapshotAltTextInput = z.infer<typeof snapshotAltTextInputSchema>;

export type SnapshotAltTextErrorCode =
  | 'PARTICIPANT_CONTENT_OWNED'
  | 'VALIDATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'PROJECT_NOT_FOUND'
  | 'SNAPSHOT_MEDIA_NOT_FOUND'
  | 'ALT_TEXT_TOO_LONG'
  | 'STALE_VERSION'
  | 'APPROVAL_REOPEN_REQUIRED'
  | 'PUBLISHED_PROJECT_LOCKED'
  | 'PERSISTENCE_FAILED'
  | 'INTERNAL_FAILURE';

export interface SnapshotAltTextView {
  publicId: string;
  mediaAssetId: string;
  snapshotAltText: string;
  /** The project version to send with the next save; advances on every successful edit. */
  expectedUpdatedAt: string;
}

export type SnapshotAltTextActionResult =
  | { ok: true; snapshot: SnapshotAltTextView }
  | { ok: false; code: SnapshotAltTextErrorCode; message: string; fieldErrors?: Record<string, string[]> };

/**
 * Bounded staff-facing messages. Never surfaces SQL, internal identifiers, storage paths, or raw
 * database errors — each message says what happened and what to do about it.
 */
export function snapshotAltTextResultMessage(code: SnapshotAltTextErrorCode): string {
  switch (code) {
    case 'STALE_VERSION':
      return 'This project changed after you opened it. Refresh and review the latest values before saving again.';
    case 'APPROVAL_REOPEN_REQUIRED':
      return 'This project is approved. Request changes before editing snapshot image alt text.';
    case 'PUBLISHED_PROJECT_LOCKED':
      return 'Published project accessibility text is locked until a controlled revision workflow is available.';
    case 'PROJECT_NOT_FOUND':
      return 'This project is no longer available.';
    case 'SNAPSHOT_MEDIA_NOT_FOUND':
      return 'This project has no snapshot image to describe.';
    case 'ALT_TEXT_TOO_LONG':
      return `Snapshot image alt text must be ${ACCESSIBLE_CONTENT_LIMITS.snapshotAltText.toLocaleString('en-US')} characters or fewer.`;
    case 'PERMISSION_DENIED':
      return 'You do not have permission to edit this project.';
    case 'VALIDATION_FAILED':
      return 'Review the highlighted fields and try again.';
    default:
      return 'We could not save your changes. Please try again.';
  }
}
