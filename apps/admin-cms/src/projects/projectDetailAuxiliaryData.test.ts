import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ParticipantPreviewPanel } from '../components/admin/ParticipantPreviewPanel';
import { PublicationPreparationPanel } from '../components/admin/PublicationPreparationPanel';
import { PublicationReadinessPanel } from '../components/admin/PublicationReadinessPanel';
import { ParticipantPreviewExecutionError } from '../repositories/ParticipantPreviewRepository';
import {
  PROJECT_AUDIT_HISTORY_SELECT,
  loadProjectDetailAuxiliaryData,
  parseAuditHistoryRow,
} from './projectDetailAuxiliaryData';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const readyResult = {
  ready: true as const,
  resultCode: 'READY' as const,
  blockers: [],
  confirmedPreviewId: 'preview-id',
  confirmedAt: '2026-08-12T00:00:00.000Z',
};

describe('project detail auxiliary failure isolation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the loaded core project renderable, marks preview unavailable, and blocks publication when preview reads fail', async () => {
    const project = { publicId: '2026-agri-iot', title: 'Agricultural IoT Hydration Roster', status: 'in_review' };
    const failures: Array<[string, string]> = [];

    const result = await loadProjectDetailAuxiliaryData(project, {
      loadAuditRecords: async () => [],
      loadPreviewState: async () => { throw new ParticipantPreviewExecutionError('INTERNAL_FAILURE'); },
      loadResolutionStatus: async () => null,
      loadPublicationReadiness: async () => readyResult,
    }, (subsystem, category) => failures.push([subsystem, category]));

    expect(result.project).toBe(project);
    expect(result.project.title).toBe('Agricultural IoT Hydration Roster');
    expect(result.previewStateAvailable).toBe(false);
    expect(result.publicationReadiness).toBeNull();
    expect(result.publicationActionsAvailable).toBe(false);
    expect(failures).toEqual([['participant preview', 'INTERNAL_FAILURE']]);

    const previewMarkup = renderToStaticMarkup(React.createElement(ParticipantPreviewPanel, {
      publicId: project.publicId,
      canManage: true,
      isApprovedEligible: true,
      initialActivePreview: result.previewState.activePreview,
      responseState: result.previewState.responseState,
      stateAvailable: result.previewStateAvailable,
      resolutionStatus: result.resolutionStatus,
      resolutionStateAvailable: result.resolutionStatusAvailable,
      canResolveCorrection: true,
      projectStatus: 'approved',
    }));
    expect(previewMarkup).toContain('Participant Preview status unavailable.');
    expect(previewMarkup).toContain('Preview actions are temporarily disabled');
    expect(previewMarkup).not.toContain('<button');

    const readinessMarkup = renderToStaticMarkup(React.createElement(PublicationReadinessPanel, { readiness: result.publicationReadiness }));
    expect(readinessMarkup).toContain('Publication readiness unavailable.');
    expect(readinessMarkup).toContain('Publication preparation and Local publication are disabled');

    const preparationMarkup = renderToStaticMarkup(React.createElement(PublicationPreparationPanel, {
      publicId: project.publicId,
      ready: result.publicationActionsAvailable,
      canPrepare: true,
      localExecutionAvailable: true,
    }));
    expect(preparationMarkup).toBe('');
  });

  it('distinguishes audit and correction-resolution failures from valid empty state and disables preview actions', async () => {
    const result = await loadProjectDetailAuxiliaryData({ publicId: '2026-vr-rehab' }, {
      loadAuditRecords: async () => { throw new Error('database detail must stay private'); },
      loadPreviewState: async () => ({ activePreview: null, responseState: { type: 'unresponded' }, notification: null, reminders: [] }),
      loadResolutionStatus: async () => { throw new ParticipantPreviewExecutionError('INTERNAL_FAILURE'); },
      loadPublicationReadiness: async () => readyResult,
    }, vi.fn());

    expect(result.auditRecords).toBeNull();
    expect(result.previewStateAvailable).toBe(true);
    expect(result.resolutionStatusAvailable).toBe(false);
    expect(result.publicationReadiness).toBeNull();
    expect(result.publicationActionsAvailable).toBe(false);

    const markup = renderToStaticMarkup(React.createElement(ParticipantPreviewPanel, {
      publicId: '2026-vr-rehab',
      canManage: true,
      isApprovedEligible: true,
      initialActivePreview: null,
      responseState: { type: 'unresponded' },
      stateAvailable: true,
      resolutionStatus: null,
      resolutionStateAvailable: false,
      canResolveCorrection: true,
      projectStatus: 'approved',
    }));
    expect(markup).toContain('Correction-resolution status unavailable.');
    expect(markup).not.toContain('<button');
  });

  it('preserves healthy preview and readiness behavior when every authoritative read succeeds', async () => {
    const result = await loadProjectDetailAuxiliaryData({ publicId: 'healthy-project' }, {
      loadAuditRecords: async () => [],
      loadPreviewState: async () => ({
        activePreview: { createdAt: '2026-08-12T00:00:00.000Z', expiresAt: '2026-08-13T00:00:00.000Z' },
        responseState: { type: 'confirmed', confirmedAt: '2026-08-12T00:05:00.000Z' },
        notification: {
          kind: 'initial' as const,
          recipient: 'group@example.invalid',
          status: 'sent' as const,
          requestedAt: '2026-08-12T00:00:05.000Z',
          sentAt: '2026-08-12T00:00:06.000Z',
          failureCode: null,
        },
        reminders: [],
      }),
      loadResolutionStatus: async () => null,
      loadPublicationReadiness: async () => readyResult,
    });

    expect(result.previewStateAvailable).toBe(true);
    expect(result.resolutionStatusAvailable).toBe(true);
    expect(result.publicationReadiness).toEqual(readyResult);
    expect(result.publicationActionsAvailable).toBe(true);
    expect(result.auditRecords).toEqual([]);
  });
});

describe('bounded project metadata audit read model', () => {
  const auditId = '10000000-0000-0000-0000-000000000001';
  const adminId = '20000000-0000-0000-0000-000000000001';
  const lookupId = '30000000-0000-0000-0000-000000000001';
  const validTitleDiff = {
    version: 1,
    type: 'project_metadata',
    changedFields: ['title'],
    before: { title: 'Before' },
    after: { title: 'After' },
  };
  const row = (eventDetails: unknown, patch: Record<string, unknown> = {}) => ({
    id: auditId,
    admin_id: adminId,
    action_taken: 'update_metadata',
    from_status: 'draft',
    to_status: 'draft',
    comments: 'Updated project metadata.',
    created_at: '2026-08-13T00:00:00.000Z',
    actor_full_name_snapshot: 'Snapshot Actor',
    actor_email_snapshot: 'snapshot@example.test',
    event_details: eventDetails,
    admin_users: { full_name: 'Current Actor', email: 'current@example.test' },
    ...patch,
  });

  function expectMalformed(details: unknown) {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const parsed = parseAuditHistoryRow(row(details));
    expect(parsed.metadataEventDetails).toBeNull();
    expect(parsed).toMatchObject({ id: auditId, action: 'update_metadata', actorFullName: 'Snapshot Actor' });
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  }

  it('exports the exact bounded production projection with the real admin FK relationship', () => {
    expect(PROJECT_AUDIT_HISTORY_SELECT).toBe(
      'id,admin_id,action_taken,from_status,to_status,comments,created_at,actor_full_name_snapshot,actor_email_snapshot,event_details,admin_users!approval_records_admin_id_fkey(full_name,email)',
    );
    expect(PROJECT_AUDIT_HISTORY_SELECT).not.toContain('*');
    expect(PROJECT_AUDIT_HISTORY_SELECT).not.toContain('first_name');
    expect(PROJECT_AUDIT_HISTORY_SELECT).not.toContain('last_name');
  });

  it('accepts valid title, program, and set diffs including nullable historical names', () => {
    expect(parseAuditHistoryRow(row(validTitleDiff)).metadataEventDetails?.changedFields).toEqual(['title']);
    expect(parseAuditHistoryRow(row({
      version: 1,
      type: 'project_metadata',
      changedFields: ['program'],
      before: { program: { id: lookupId, name: null } },
      after: { program: { id: '30000000-0000-0000-0000-000000000002', name: 'New program' } },
    })).metadataEventDetails?.before.program?.name).toBeNull();
    expect(parseAuditHistoryRow(row({
      version: 1,
      type: 'project_metadata',
      changedFields: ['disciplines'],
      before: { disciplines: [{ id: lookupId, name: null }] },
      after: { disciplines: [{ id: '30000000-0000-0000-0000-000000000002', name: 'New discipline' }] },
    })).metadataEventDetails?.changedFields).toEqual(['disciplines']);
  });

  it.each([
    ['unknown changed field', { ...validTitleDiff, changedFields: ['unknown'] }],
    ['duplicate changed field', { ...validTitleDiff, changedFields: ['title', 'title'] }],
    ['missing before entry', { ...validTitleDiff, before: {} }],
    ['missing after entry', { ...validTitleDiff, after: {} }],
    ['extra arbitrary state key', { ...validTitleDiff, before: { title: 'Before', arbitrary: true } }],
    ['malformed set item', {
      version: 1,
      type: 'project_metadata',
      changedFields: ['industryCategories'],
      before: { industryCategories: [{ id: 'not-a-uuid', name: null }] },
      after: { industryCategories: [{ id: lookupId, name: 'Industry' }] },
    }],
  ])('degrades %s details to null while preserving the valid base event', (_name, details) => {
    expectMalformed(details);
  });

  it('prefers snapshots, falls back to real admin_users fields, then uses a safe unknown label', () => {
    expect(parseAuditHistoryRow(row(null)).actorFullName).toBe('Snapshot Actor');
    expect(parseAuditHistoryRow(row(null, {
      actor_full_name_snapshot: null,
      actor_email_snapshot: null,
    }))).toMatchObject({ actorFullName: 'Current Actor', actorEmail: 'current@example.test' });
    expect(parseAuditHistoryRow(row(null, {
      admin_id: null,
      actor_full_name_snapshot: null,
      actor_email_snapshot: null,
      admin_users: null,
    }))).toMatchObject({ actorFullName: 'Unknown staff member', actorEmail: null });
  });

  it('rejects fields outside the bounded approval_records row model', () => {
    expect(() => parseAuditHistoryRow(row(null, { unexpected_column: 'not selected' }))).toThrow();
  });
});
