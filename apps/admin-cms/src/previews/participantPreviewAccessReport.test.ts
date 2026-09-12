import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { readPreviewAccessReport } from './participantPreviewAccessReport';

const previewIdA = '10000000-0000-4000-8000-000000000001';
const previewIdB = '10000000-0000-4000-8000-000000000002';
const projectId = '20000000-0000-4000-8000-000000000001';

function clientFor(overrides: Record<string, { data: unknown[]; error: unknown; count?: number }> = {}) {
  const defaults: Record<string, { data: unknown[]; error: unknown; count?: number }> = {
    participant_previews: { data: [
      { id: previewIdA, project_id: projectId, created_at: '2026-09-01T00:00:00Z', expires_at: '2026-09-08T00:00:00Z', status: 'active', revoked_at: null },
      { id: previewIdB, project_id: projectId, created_at: '2026-09-02T00:00:00Z', expires_at: '2026-09-09T00:00:00Z', status: 'revoked', revoked_at: '2026-09-03T00:00:00Z' },
    ], error: null, count: 2 },
    projects: { data: [{ id: projectId, public_id: 'synthetic-project' }], error: null },
    participant_preview_access_observations: { data: [{ participant_preview_id: previewIdA, first_response_prepared_at: '2026-09-01T00:01:00Z' }], error: null },
    participant_preview_confirmations: { data: [{ participant_preview_id: previewIdA, confirmed_at: '2026-09-01T02:00:00Z' }], error: null },
    participant_preview_correction_requests: { data: [{ participant_preview_id: previewIdB, requested_at: '2026-09-02T03:00:00Z', status: 'resolved', resolved_at: '2026-09-04T00:00:00Z' }], error: null },
  };
  const selected: string[] = [];
  const from = (table: string) => {
    const result = { ...defaults[table], ...overrides[table] };
    const query: Record<string, unknown> = {};
    for (const method of ['gte', 'lt', 'order', 'limit', 'or', 'in']) query[method] = () => query;
    query.select = (columns: string) => { selected.push(`${table}:${columns}`); return query; };
    query.then = (resolve: (value: unknown) => void) => Promise.resolve(result).then(resolve);
    return query;
  };
  return { client: { from } as unknown as SupabaseClient, selected };
}

describe('bounded KPI-09 preview evidence export', () => {
  it('reports an exact complete cohort without inventing human access or confirmation', async () => {
    const boundary = clientFor();
    const report = await readPreviewAccessReport(boundary.client, {
      issuedFrom: '2026-09-01T00:00:00Z', issuedBefore: '2026-10-01T00:00:00Z', limit: 100,
    });
    expect(report.cohort).toEqual({
      issuedFromInclusive: '2026-09-01T00:00:00Z', issuedBeforeExclusive: '2026-10-01T00:00:00Z', totalPreviewVersions: 2,
    });
    expect(report.page.completeCohort).toBe(true);
    expect(report.measurement.responsePrepared).toMatchObject({ numerator: 1, denominator: 2, rate: 0.5, result: 'not_met' });
    expect(report.measurement.onTimeConfirmation).toMatchObject({ numerator: 1, denominator: 2, rate: 0.5, result: 'not_met' });
    expect(report.rows[0].confirmation).toEqual({ confirmedAt: '2026-09-01T02:00:00Z', onTime: true });
    expect(report.rows[1].exceptionCodes).toEqual([
      'RESPONSE_PREPARATION_NOT_RECORDED', 'CORRECTION_REQUESTED', 'PREVIEW_REVOKED',
    ]);
    expect(JSON.stringify(report)).not.toMatch(/token_hash|email|ip_address|user_agent/i);
    expect(boundary.selected).toContain('participant_previews:id,project_id,created_at,expires_at,status,revoked_at');
  });

  it('does not evaluate cohort thresholds from a partial bounded page', async () => {
    const boundary = clientFor({ participant_previews: {
      data: [
        { id: previewIdA, project_id: projectId, created_at: '2026-09-01T00:00:00Z', expires_at: '2026-09-08T00:00:00Z', status: 'active', revoked_at: null },
        { id: previewIdB, project_id: projectId, created_at: '2026-09-02T00:00:00Z', expires_at: '2026-09-09T00:00:00Z', status: 'active', revoked_at: null },
      ], error: null, count: 20,
    } });
    const report = await readPreviewAccessReport(boundary.client, {
      issuedFrom: '2026-09-01T00:00:00Z', issuedBefore: '2026-10-01T00:00:00Z', limit: 1,
    });
    expect(report.page.completeCohort).toBe(false);
    expect(report.page.nextCursor).toEqual({ issuedAt: '2026-09-01T00:00:00Z', previewId: previewIdA });
    expect(report.measurement.responsePrepared.result).toBe('not_evaluated');
    expect(report.measurement.onTimeConfirmation.result).toBe('not_evaluated');
  });

  it('distinguishes unavailable evidence from successfully read absent observations', async () => {
    const boundary = clientFor({ participant_preview_access_observations: { data: [], error: { message: 'private detail' } } });
    await expect(readPreviewAccessReport(boundary.client, {
      issuedFrom: '2026-09-01T00:00:00Z', issuedBefore: '2026-10-01T00:00:00Z',
    })).rejects.toThrow(/^KPI09_EVIDENCE_UNAVAILABLE$/);
  });

  it('rejects unbounded or malformed cohort input before querying', async () => {
    const boundary = clientFor();
    await expect(readPreviewAccessReport(boundary.client, {
      issuedFrom: 'bad', issuedBefore: '2026-10-01T00:00:00Z', limit: 101,
    })).rejects.toThrow('KPI09_COHORT_INVALID');
    expect(boundary.selected).toEqual([]);
  });
});
