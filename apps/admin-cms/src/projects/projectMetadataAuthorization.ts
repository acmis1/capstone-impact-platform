import { AdminPermission } from '../auth/authTypes';
import { hasPermission } from '../auth/permissions';
import { ProjectMetadataActionResult, metadataResultMessage } from './projectMetadata';
import type { ProjectMetadataGateway } from './projectMetadataService';
import { PARTICIPANT_CONTENT_OWNED } from './contentOwnership';

/** Keeps authorization ahead of persistence for direct mutation invocations. */
export async function saveAuthorizedProjectMetadata(
  permissions: AdminPermission[],
  _gateway: ProjectMetadataGateway,
  _rawInput: unknown,
  _actorAdminUserId: string,
): Promise<ProjectMetadataActionResult> {
  void _gateway; void _rawInput; void _actorAdminUserId; // Compatibility arguments cannot authorize content mutation.
  if (!hasPermission(permissions, 'projects.edit')) {
    return { ok: false, code: 'PERMISSION_DENIED', message: metadataResultMessage('PERMISSION_DENIED') };
  }
  return PARTICIPANT_CONTENT_OWNED;
}
