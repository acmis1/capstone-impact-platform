'use server';

import { requireAdmin } from '../../../../auth/requireAdmin';
import { AdminAuthError } from '../../../../auth/authTypes';
import { hasPermission } from '../../../../auth/permissions';
import { ProjectMetadataActionResult, metadataResultMessage } from '../../../../projects/projectMetadata';
import { SnapshotAltTextActionResult, snapshotAltTextResultMessage } from '../../../../projects/snapshotAltText';
import { PARTICIPANT_CONTENT_OWNED } from '../../../../projects/contentOwnership';

/** Legacy staff action retained to deny old clients explicitly, without creating a database gateway. */
export async function saveProjectMetadataAction(_rawInput: unknown): Promise<ProjectMetadataActionResult> {
  void _rawInput; // Legacy payload is intentionally discarded before any persistence.
  try {
    const context = await requireAdmin();
    if (!hasPermission(context.permissions, 'projects.edit')) return { ok: false, code: 'PERMISSION_DENIED', message: metadataResultMessage('PERMISSION_DENIED') };
    return PARTICIPANT_CONTENT_OWNED;
  } catch (error) {
    const code = error instanceof AdminAuthError ? 'PERMISSION_DENIED' : 'INTERNAL_FAILURE';
    return { ok: false, code, message: metadataResultMessage(code) };
  }
}

/** Snapshot descriptions can only change through acceptance of a participant-authored package. */
export async function saveSnapshotAltTextAction(_rawInput: unknown): Promise<SnapshotAltTextActionResult> {
  void _rawInput;
  try {
    const context = await requireAdmin();
    if (!hasPermission(context.permissions, 'projects.edit')) return { ok: false, code: 'PERMISSION_DENIED', message: snapshotAltTextResultMessage('PERMISSION_DENIED') };
    return PARTICIPANT_CONTENT_OWNED;
  } catch (error) {
    const code = error instanceof AdminAuthError ? 'PERMISSION_DENIED' : 'INTERNAL_FAILURE';
    return { ok: false, code, message: snapshotAltTextResultMessage(code) };
  }
}
