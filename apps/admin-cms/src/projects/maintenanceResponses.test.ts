import { describe, expect, it } from 'vitest';
import { parseProjectLayoutMaintenanceResponse } from './projectLayoutMaintenanceResponse';
import { parseDeletedProjectDetailResponse, parseDeletedProjectListResponse, parseDeletedProjectRecoveryResponse } from '../recovery/deletedProjectMaintenanceResponses';

const id = '11111111-1111-4111-8111-111111111111';
const at = '2026-09-18T12:00:00.123456+00:00';
const layout = { resultCode: 'UPDATED', publicId: 'synthetic', status: 'draft', updatedAt: at, auditRecordId: id, revokedActivePreviewCount: 1 };
const recovered = { resultCode: 'RECOVERED', publicId: 'synthetic', status: 'draft', updatedAt: at, auditRecordId: id, rearmedPublicMappingRows: 2 };
const recovery = { code: 'READY_FOR_RECOVERY', reason: 'Synthetic exact deletion evidence.', softDeleteAuditId: id };
const row = { publicId: 'synthetic', title: 'Synthetic project', status: 'deleted', deletedAt: at, updatedAt: at, createdAt: at, recovery };
const list = { items: [row], total: 1, page: 1, pageSize: 20, pageCount: 1 };

describe('strict governed-maintenance response boundaries', () => {
  it('accepts coherent success and known safe refusals', () => {
    expect(parseProjectLayoutMaintenanceResponse(layout, 'synthetic')).toEqual(layout);
    expect(parseProjectLayoutMaintenanceResponse({ resultCode: 'LAYOUT_EVIDENCE_REMOVAL_PENDING' }, 'synthetic').resultCode).toBe('LAYOUT_EVIDENCE_REMOVAL_PENDING');
    expect(parseDeletedProjectRecoveryResponse(recovered, 'synthetic')).toEqual(recovered);
    expect(parseDeletedProjectRecoveryResponse({ resultCode: 'RECOVERY_REMOVAL_PENDING', code: 'RECOVERY_REMOVAL_PENDING', reason: 'Pending.' }, 'synthetic').resultCode).toBe('RECOVERY_REMOVAL_PENDING');
    expect(parseDeletedProjectListResponse(list, 1, 20)).toEqual(list);
  });
  it.each([
    { publicId: 'different' }, { auditRecordId: 'invalid' }, { updatedAt: 'yesterday' },
    { revokedActivePreviewCount: -1 }, { revokedActivePreviewCount: 0.5 }, { revokedActivePreviewCount: 2 },
    { status: 'published' }, { secret: 'not-allowed' }, { resultCode: 'SUCCESS' },
  ])('refuses malformed or cross-project layout result %j', patch => {
    expect(() => parseProjectLayoutMaintenanceResponse({ ...layout, ...patch }, 'synthetic')).toThrow();
  });
  it.each([
    { publicId: 'different' }, { status: 'published' }, { rearmedPublicMappingRows: -1 },
    { rearmedPublicMappingRows: NaN }, { auditRecordId: '' }, { updatedAt: 'invalid' },
    { resultCode: 'ALREADY_RECOVERED', auditRecordId: id }, { unverifiedSuccess: true },
  ])('refuses invalid recovery result %j', patch => {
    expect(() => parseDeletedProjectRecoveryResponse({ ...recovered, ...patch }, 'synthetic')).toThrow();
  });
  it.each([
    { total: -1 }, { page: 2 }, { pageSize: 50 }, { pageCount: 2 },
    { items: [row, row], total: 2 }, { items: [{ ...row, updatedAt: null }] },
    { items: [{ ...row, status: 'draft' }] }, { items: [{ ...row, recovery: { ...recovery, softDeleteAuditId: undefined } }] },
  ])('rejects misleading deleted-list shape or eligibility %j', patch => {
    expect(() => parseDeletedProjectListResponse({ ...list, ...patch }, 1, 20)).toThrow();
  });
  it('accepts empty lists without conflating an unavailable response with no records', () => {
    expect(parseDeletedProjectListResponse({ ...list, items: [], total: 0, pageCount: 0 }, 1, 20).items).toEqual([]);
    expect(() => parseDeletedProjectListResponse({ resultCode: 'PERMISSION_DENIED' }, 1, 20)).toThrow();
  });
  it('requires a fully validated tombstone, not merely an object with arrays', () => {
    const detail = { resultCode: 'FOUND', project: { id, ...row, recovery: undefined, summary: null, background: null, solution: null, year: 2026, program: null, discipline: null, industry: null, groupName: null }, recovery, media: [], approvalHistory: [], participantPreviews: [], feedHistory: [] };
    const { recovery: omitted, ...project } = detail.project;
    void omitted;
    const valid = { ...detail, project };
    expect(parseDeletedProjectDetailResponse(valid, 'synthetic')).toEqual(valid);
    expect(() => parseDeletedProjectDetailResponse(valid, 'other')).toThrow();
    expect(() => parseDeletedProjectDetailResponse({ ...valid, media: [{}] }, 'synthetic')).toThrow();
    expect(parseDeletedProjectDetailResponse({ resultCode: 'PROJECT_NOT_FOUND' }, 'synthetic')).toBeNull();
  });
});
