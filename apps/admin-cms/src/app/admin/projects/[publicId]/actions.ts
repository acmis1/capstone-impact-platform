'use server';

import { requireAdmin } from '../../../../auth/requireAdmin';
import { AdminAuthError } from '../../../../auth/authTypes';
import { createSupabaseAdminClient } from '../../../../lib/supabase/admin';
import { ProjectMetadataActionResult, metadataResultMessage } from '../../../../projects/projectMetadata';
import { SupabaseProjectMetadataGateway } from '../../../../projects/projectMetadataService';
import { saveAuthorizedProjectMetadata } from '../../../../projects/projectMetadataAuthorization';
import { SnapshotAltTextActionResult, snapshotAltTextResultMessage } from '../../../../projects/snapshotAltText';
import {
  SupabaseSnapshotAltTextGateway,
  saveAuthorizedSnapshotAltText,
} from '../../../../projects/snapshotAltTextService';

export async function saveProjectMetadataAction(rawInput: unknown): Promise<ProjectMetadataActionResult> {
  try {
    const context = await requireAdmin();
    return await saveAuthorizedProjectMetadata(context.permissions, new SupabaseProjectMetadataGateway(createSupabaseAdminClient()), rawInput, context.adminUserId);
  } catch (error) {
    console.error('[Project metadata action failure]', error instanceof Error ? error.message : 'unknown');
    if (error instanceof AdminAuthError) {
      return { ok: false, code: 'PERMISSION_DENIED', message: metadataResultMessage('PERMISSION_DENIED') };
    }
    return { ok: false, code: 'INTERNAL_FAILURE', message: metadataResultMessage('INTERNAL_FAILURE') };
  }
}

/**
 * Saves the authoritative text alternative for one snapshot image.
 * Actor identity and permissions come from requireAdmin() on the server.
 * The browser supplies the project public id, target media asset id, text,
 * and project version. The database independently verifies that the media
 * asset belongs to that project and is a snapshot_image.
 */
export async function saveSnapshotAltTextAction(rawInput: unknown): Promise<SnapshotAltTextActionResult> {
  try {
    const context = await requireAdmin();
    return await saveAuthorizedSnapshotAltText(
      context.permissions,
      new SupabaseSnapshotAltTextGateway(createSupabaseAdminClient()),
      rawInput,
      context.adminUserId,
    );
  } catch (error) {
    console.error('[Snapshot alt text action failure]', error instanceof Error ? error.message : 'unknown');
    if (error instanceof AdminAuthError) {
      return { ok: false, code: 'PERMISSION_DENIED', message: snapshotAltTextResultMessage('PERMISSION_DENIED') };
    }
    return { ok: false, code: 'INTERNAL_FAILURE', message: snapshotAltTextResultMessage('INTERNAL_FAILURE') };
  }
}
