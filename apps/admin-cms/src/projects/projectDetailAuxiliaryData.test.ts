import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ParticipantPreviewPanel } from '../components/admin/ParticipantPreviewPanel';
import { PublicationPreparationPanel } from '../components/admin/PublicationPreparationPanel';
import { PublicationReadinessPanel } from '../components/admin/PublicationReadinessPanel';
import { ParticipantPreviewExecutionError } from '../repositories/ParticipantPreviewRepository';
import { loadProjectDetailAuxiliaryData } from './projectDetailAuxiliaryData';

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
      loadPreviewState: async () => ({ activePreview: null, responseState: { type: 'unresponded' } }),
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
