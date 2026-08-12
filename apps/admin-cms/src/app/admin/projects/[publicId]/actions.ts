'use server';

import { requireAdmin } from '../../../../auth/requireAdmin';
import { AdminAuthError } from '../../../../auth/authTypes';
import { createSupabaseAdminClient } from '../../../../lib/supabase/admin';
import { ProjectMetadataActionResult, metadataResultMessage } from '../../../../projects/projectMetadata';
import { SupabaseProjectMetadataGateway } from '../../../../projects/projectMetadataService';
import { saveAuthorizedProjectMetadata } from '../../../../projects/projectMetadataAuthorization';

export async function saveProjectMetadataAction(rawInput: unknown): Promise<ProjectMetadataActionResult> {
  try {
    const context = await requireAdmin();
    return await saveAuthorizedProjectMetadata(context.permissions, new SupabaseProjectMetadataGateway(createSupabaseAdminClient()), rawInput);
  } catch (error) {
    console.error('[Project metadata action failure]', error instanceof Error ? error.message : 'unknown');
    if (error instanceof AdminAuthError) {
      return { ok: false, code: 'PERMISSION_DENIED', message: metadataResultMessage('PERMISSION_DENIED') };
    }
    return { ok: false, code: 'INTERNAL_FAILURE', message: metadataResultMessage('INTERNAL_FAILURE') };
  }
}
