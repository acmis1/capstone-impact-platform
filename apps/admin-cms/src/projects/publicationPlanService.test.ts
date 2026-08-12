import { describe, expect, it, vi } from 'vitest';
import { getPermissionsForRoles } from '../auth/permissions';
import { compilePublicationCandidateFeed } from '../feed/compilePublicFeed';
import { serializePublicFeedArtifact } from '../feed/serializePublicFeedArtifact';
import { createMockProject } from '../test/projectFixtures';
import { preparePublicationPlan } from './publicationPlanService';

const adminPermissions = getPermissionsForRoles(['admin']);
const ready = {
  ready: true,
  resultCode: 'READY' as const,
  blockers: [],
  confirmedPreviewId: 'preview-1',
  confirmedAt: '2026-08-12T03:04:05.000Z',
};

describe('preparePublicationPlan', () => {
  it('returns the exact READY_TO_STAGE evidence for the actual published baseline plus approved target artifact', async () => {
    const publishedBaseline = createMockProject({
      id: 1001,
      publicId: 'published-baseline',
      title: 'Existing public project',
      status: 'published',
    });
    const approvedTarget = createMockProject({
      id: 1002,
      publicId: 'approved-target',
      title: 'Approved publication target',
      status: 'approved',
    });
    const excludedDraft = createMockProject({
      id: 1003,
      publicId: 'excluded-draft',
      status: 'draft',
    });
    const projects = [publishedBaseline, excludedDraft, approvedTarget];
    const expectedArtifact = serializePublicFeedArtifact(
      compilePublicationCandidateFeed(projects, 'approved-target'),
    );

    const result = await preparePublicationPlan(adminPermissions, 'approved-target', {
      getReadiness: vi.fn().mockResolvedValue(ready),
      listProjects: vi.fn().mockResolvedValue(projects),
    });

    expect(result).toEqual({
      resultCode: 'READY_TO_STAGE',
      publicId: 'approved-target',
      confirmedPreviewId: 'preview-1',
      confirmedAt: '2026-08-12T03:04:05.000Z',
      recordCount: expectedArtifact.recordCount,
      feedHash: expectedArtifact.feedHash,
    });
    expect(expectedArtifact.recordCount).toBe(2);
  });

  it('preserves the exact NOT_READY code and blockers without listing projects', async () => {
    const listProjects = vi.fn();

    const result = await preparePublicationPlan(adminPermissions, 'target', {
      getReadiness: vi.fn().mockResolvedValue({
        ready: false,
        resultCode: 'CORRECTION_UNRESOLVED',
        blockers: ['Participant correction remains unresolved', 'Replacement preview required'],
      }),
      listProjects,
    });

    expect(result).toEqual({
      resultCode: 'NOT_READY',
      readinessCode: 'CORRECTION_UNRESOLVED',
      blockers: ['Participant correction remains unresolved', 'Replacement preview required'],
    });
    expect(listProjects).not.toHaveBeenCalled();
  });

  it('fails closed when READY evidence is missing confirmedPreviewId without listing projects', async () => {
    const listProjects = vi.fn();

    const result = await preparePublicationPlan(adminPermissions, 'target', {
      getReadiness: vi.fn().mockResolvedValue({ ...ready, confirmedPreviewId: undefined }),
      listProjects,
    });

    expect(result).toEqual({ resultCode: 'NOT_READY', readinessCode: 'READY', blockers: [] });
    expect(listProjects).not.toHaveBeenCalled();
  });

  it('fails closed when READY evidence is missing confirmedAt without listing projects', async () => {
    const listProjects = vi.fn();

    const result = await preparePublicationPlan(adminPermissions, 'target', {
      getReadiness: vi.fn().mockResolvedValue({ ...ready, confirmedAt: undefined }),
      listProjects,
    });

    expect(result).toEqual({ resultCode: 'NOT_READY', readinessCode: 'READY', blockers: [] });
    expect(listProjects).not.toHaveBeenCalled();
  });

  it('returns PLAN_UNAVAILABLE without propagating a getReadiness failure', async () => {
    const listProjects = vi.fn();

    const result = await preparePublicationPlan(adminPermissions, 'target', {
      getReadiness: vi.fn().mockRejectedValue(new Error('raw readiness database error')),
      listProjects,
    });

    expect(result).toEqual({ resultCode: 'PLAN_UNAVAILABLE' });
    expect(listProjects).not.toHaveBeenCalled();
  });

  it('returns PLAN_UNAVAILABLE without propagating a listProjects failure', async () => {
    const result = await preparePublicationPlan(adminPermissions, 'target', {
      getReadiness: vi.fn().mockResolvedValue(ready),
      listProjects: vi.fn().mockRejectedValue(new Error('raw project database error')),
    });

    expect(result).toEqual({ resultCode: 'PLAN_UNAVAILABLE' });
  });

  it('returns PLAN_UNAVAILABLE when the approved target is absent', async () => {
    const result = await preparePublicationPlan(adminPermissions, 'missing-target', {
      getReadiness: vi.fn().mockResolvedValue(ready),
      listProjects: vi.fn().mockResolvedValue([
        createMockProject({ publicId: 'published-baseline', status: 'published' }),
      ]),
    });

    expect(result).toEqual({ resultCode: 'PLAN_UNAVAILABLE' });
  });

  it('returns PLAN_UNAVAILABLE when the target public ID is duplicated', async () => {
    const result = await preparePublicationPlan(adminPermissions, 'duplicate-target', {
      getReadiness: vi.fn().mockResolvedValue(ready),
      listProjects: vi.fn().mockResolvedValue([
        createMockProject({ id: 2001, publicId: 'duplicate-target', status: 'approved' }),
        createMockProject({ id: 2002, publicId: 'duplicate-target', status: 'approved' }),
      ]),
    });

    expect(result).toEqual({ resultCode: 'PLAN_UNAVAILABLE' });
  });

  it('returns PLAN_UNAVAILABLE when the exact target is already published instead of approved', async () => {
    const result = await preparePublicationPlan(adminPermissions, 'published-target', {
      getReadiness: vi.fn().mockResolvedValue(ready),
      listProjects: vi.fn().mockResolvedValue([
        createMockProject({ publicId: 'published-target', status: 'published' }),
      ]),
    });

    expect(result).toEqual({ resultCode: 'PLAN_UNAVAILABLE' });
  });

  it('returns PLAN_UNAVAILABLE when the compiled candidate fails the real public-feed validator', async () => {
    const result = await preparePublicationPlan(adminPermissions, 'invalid-target', {
      getReadiness: vi.fn().mockResolvedValue(ready),
      listProjects: vi.fn().mockResolvedValue([
        createMockProject({ id: 1.5, publicId: 'invalid-target', status: 'approved' }),
      ]),
    });

    expect(result).toEqual({ resultCode: 'PLAN_UNAVAILABLE' });
  });

  it('denies a reviewer before either dependency executes', async () => {
    const getReadiness = vi.fn();
    const listProjects = vi.fn();

    const result = await preparePublicationPlan(getPermissionsForRoles(['reviewer']), 'target', {
      getReadiness,
      listProjects,
    });

    expect(result).toEqual({ resultCode: 'PERMISSION_DENIED' });
    expect(getReadiness).toHaveBeenCalledTimes(0);
    expect(listProjects).toHaveBeenCalledTimes(0);
  });

  it('denies an editor before either dependency executes', async () => {
    const getReadiness = vi.fn();
    const listProjects = vi.fn();

    const result = await preparePublicationPlan(getPermissionsForRoles(['editor']), 'target', {
      getReadiness,
      listProjects,
    });

    expect(result).toEqual({ resultCode: 'PERMISSION_DENIED' });
    expect(getReadiness).toHaveBeenCalledTimes(0);
    expect(listProjects).toHaveBeenCalledTimes(0);
  });
});
