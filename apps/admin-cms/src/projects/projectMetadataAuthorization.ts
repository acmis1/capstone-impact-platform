import { AdminPermission } from '../auth/authTypes';
import { hasPermission } from '../auth/permissions';
import { ProjectMetadataActionResult, metadataResultMessage } from './projectMetadata';
import { ProjectMetadataGateway, saveProjectMetadata } from './projectMetadataService';

/** Keeps authorization ahead of persistence for direct mutation invocations. */
export async function saveAuthorizedProjectMetadata(
  permissions: AdminPermission[],
  gateway: ProjectMetadataGateway,
  rawInput: unknown,
  actorAdminUserId: string,
): Promise<ProjectMetadataActionResult> {
  if (!hasPermission(permissions, 'projects.edit')) {
    return { ok: false, code: 'PERMISSION_DENIED', message: metadataResultMessage('PERMISSION_DENIED') };
  }
  return saveProjectMetadata(gateway, rawInput, actorAdminUserId);
}
