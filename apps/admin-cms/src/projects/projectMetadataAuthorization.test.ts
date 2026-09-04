import { describe, expect, it } from 'vitest';
import { getPermissionsForRoles } from '../auth/permissions';
import { ProjectMetadataGateway } from './projectMetadataService';
import { saveAuthorizedProjectMetadata } from './projectMetadataAuthorization';

const gateway = { loadProject: async () => { throw new Error('Persistence must not be reached'); } } as unknown as ProjectMetadataGateway;

describe('project metadata authorization boundary', () => {
  it('denies direct content writes for admin and editor permissions', async () => {
    const adminResult = await saveAuthorizedProjectMetadata(getPermissionsForRoles(['admin']), gateway, {}, 'test-admin-user');
    const editorResult = await saveAuthorizedProjectMetadata(getPermissionsForRoles(['editor']), gateway, {}, 'test-admin-user');
    expect(adminResult).toMatchObject({ ok: false, code: 'PARTICIPANT_CONTENT_OWNED' });
    expect(editorResult).toMatchObject({ ok: false, code: 'PARTICIPANT_CONTENT_OWNED' });
  });
  it('denies reviewers before the persistence gateway is invoked', async () => {
    const result = await saveAuthorizedProjectMetadata(getPermissionsForRoles(['reviewer']), gateway, {}, 'test-admin-user');
    expect(result).toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
