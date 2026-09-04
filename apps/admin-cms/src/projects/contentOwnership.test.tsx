// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { getPermissionsForRoles } from '../auth/permissions';
import { saveAuthorizedProjectMetadata } from './projectMetadataAuthorization';
import { saveAuthorizedSnapshotAltText } from './snapshotAltTextService';
import type { ProjectMetadataGateway } from './projectMetadataService';
import { ProjectMetadataEditor } from '../components/admin/ProjectMetadataEditor';
import { SnapshotAltTextEditor } from '../components/admin/SnapshotAltTextEditor';
import { renderParticipantCorrectionForm } from '../previews/participantCorrectionHtml';

afterEach(cleanup);
describe('participant content ownership', () => {
  it.each(['admin', 'editor'] as const)('rejects direct %s metadata and snapshot authoring before persistence', async (role) => {
    const update = vi.fn(); const permissions = getPermissionsForRoles([role]);
    const gateway = { updateMetadataAtomically: update, loadOptions: update } as unknown as ProjectMetadataGateway;
    expect(await saveAuthorizedProjectMetadata(permissions, gateway, { title: 'Override' }, 'synthetic-actor')).toMatchObject({ ok: false, code: 'PARTICIPANT_CONTENT_OWNED' });
    expect(await saveAuthorizedSnapshotAltText(permissions, { updateSnapshotAltTextAtomically: update }, { snapshotAltText: 'Override' }, 'synthetic-actor')).toMatchObject({ ok: false, code: 'PARTICIPANT_CONTENT_OWNED' });
    expect(update).not.toHaveBeenCalled();
    expect(permissions).toContain('projects.edit');
    if (role === 'admin') expect(permissions).toContain('projects.review');
  });
  it('shows ownership guidance without an edit or save control', () => {
    render(<ProjectMetadataEditor initialMetadata={{} as never} programs={[]} disciplines={[]} industryCategories={[]} canEdit projectStatus="draft" saveAction={vi.fn()} />);
    expect(screen.getByText(/Project content is owned by the project team/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull(); expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('preserves snapshot descriptions as read-only evidence for editing roles', () => {
    render(<SnapshotAltTextEditor publicId="2026-synthetic" mediaAssetId="synthetic-media" initialAltText="Participant description" expectedUpdatedAt="2026-09-03T00:00:00Z" canEdit projectStatus="draft" saveAction={vi.fn()} onSavedExpectedUpdatedAt={vi.fn()} />);
    expect(screen.getByText('Participant description')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull(); expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('renders a script-free labelled multipart form and associated focused error summary', () => {
    const { container } = render(<div dangerouslySetInnerHTML={{ __html: renderParticipantCorrectionForm({ submitted: false, canSubmit: true, error: { field: 'workbook', message: 'Fix the workbook.' } }) }} />);
    expect(container.querySelectorAll('input[type="file"]').length).toBe(13);
    expect(screen.getByLabelText('Project details workbook').getAttribute('aria-describedby')).toContain('package-error');
    expect(screen.getByRole('alert').hasAttribute('autofocus')).toBe(true);
    expect(container.querySelectorAll('script, iframe, input[name="token"], input[name="projectId"]').length).toBe(0);
  });
});
