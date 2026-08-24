import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PublicFeedHeadRecord } from '../repositories/SupabasePublicFeedLedgerRepositoryCore';
import { findPublicationCompletionEvidence, findRemovalCompletionEvidence } from './publicFeedTargetEvidence';

type Row = Record<string, unknown>;

/** Minimal in-memory stand-in for the subset of PostgREST filters this module uses. */
function createSupabaseStub(tables: Record<string, Row[]>): SupabaseClient {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const api = {
      select: () => api,
      eq: (column: string, value: unknown) => { rows = rows.filter((row) => row[column] === value); return api; },
      lte: (column: string, value: number) => { rows = rows.filter((row) => Number(row[column]) <= value); return api; },
      gt: (column: string, value: number) => { rows = rows.filter((row) => Number(row[column]) > value); return api; },
      in: (column: string, values: unknown[]) => { rows = rows.filter((row) => values.includes(row[column])); return api; },
      order: (column: string, options?: { ascending?: boolean }) => {
        const direction = options?.ascending === false ? -1 : 1;
        rows = [...rows].sort((left, right) => {
          if (left[column] === right[column]) return 0;
          return ((left[column] as number) < (right[column] as number) ? -1 : 1) * direction;
        });
        return api;
      },
      limit: (count: number) => { rows = rows.slice(0, count); return api; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return api;
  };
  return { from } as unknown as SupabaseClient;
}

function head(versionId: string, versionNumber: number, overrides: Record<string, unknown> = {}): PublicFeedHeadRecord {
  return {
    generation: versionNumber, rollbackEnabled: true,
    currentVersion: {
      id: versionId, versionNumber, operation: 'publication', publicationMode: 'normal',
      operationId: 'head-operation', previousVersionId: null, restoredFromVersionId: null,
      projectId: null, affectedPublicId: null, authorizingActorId: 'admin', completionActorId: 'admin',
      artifactContent: '[]', byteCount: 2, feedHash: 'f'.repeat(64), recordCount: 2,
      publishedSnapshotId: 'head-snapshot', auditRecordId: 'head-audit',
      createdAt: '2026-08-24T00:00:00.000Z', ...overrides,
    },
  };
}

const HASH_A = 'a'.repeat(64);
const HASH_A_CHANGED = 'c'.repeat(64);

describe('target-specific publication completion evidence', () => {
  it('returns project A evidence after project B has taken over the head', async () => {
    const supabase = createSupabaseStub({
      public_feed_versions: [
        { id: 'v2', version_number: 2, operation: 'publication', affected_public_id: 'A', operation_id: 'op-A', published_snapshot_id: 'snap-A', audit_record_id: 'audit-A' },
        { id: 'v3', version_number: 3, operation: 'publication', affected_public_id: 'B', operation_id: 'op-B', published_snapshot_id: 'snap-B', audit_record_id: 'audit-B' },
      ],
      public_feed_version_members: [
        { version_id: 'v2', public_id: 'A', record_hash: HASH_A },
        { version_id: 'v3', public_id: 'A', record_hash: HASH_A },
        { version_id: 'v3', public_id: 'B', record_hash: 'b'.repeat(64) },
      ],
    });

    await expect(findPublicationCompletionEvidence(supabase, 'A', head('v3', 3))).resolves.toEqual({
      operationId: 'op-A', versionNumber: 2, publishedSnapshotId: 'snap-A', auditRecordId: 'audit-A',
    });
  });

  it('resolves evidence through a rollback head whose restored record bytes are unchanged', async () => {
    const supabase = createSupabaseStub({
      public_feed_versions: [
        { id: 'v2', version_number: 2, operation: 'publication', affected_public_id: 'A', operation_id: 'op-A', published_snapshot_id: 'snap-A', audit_record_id: 'audit-A' },
        { id: 'v4', version_number: 4, operation: 'rollback', affected_public_id: null, operation_id: 'op-rollback', published_snapshot_id: null, audit_record_id: null },
      ],
      public_feed_version_members: [
        { version_id: 'v2', public_id: 'A', record_hash: HASH_A },
        { version_id: 'v4', public_id: 'A', record_hash: HASH_A },
      ],
    });

    const evidence = await findPublicationCompletionEvidence(
      supabase, 'A', head('v4', 4, { operation: 'rollback', publicationMode: null, operationId: 'op-rollback', publishedSnapshotId: null, auditRecordId: null }),
    );
    expect(evidence).toEqual({ operationId: 'op-A', versionNumber: 2, publishedSnapshotId: 'snap-A', auditRecordId: 'audit-A' });
  });

  it('refuses to invent evidence when no publication explains the deployed record bytes', async () => {
    const supabase = createSupabaseStub({
      public_feed_versions: [
        { id: 'v2', version_number: 2, operation: 'publication', affected_public_id: 'A', operation_id: 'op-A', published_snapshot_id: 'snap-A', audit_record_id: 'audit-A' },
      ],
      public_feed_version_members: [
        { version_id: 'v2', public_id: 'A', record_hash: HASH_A },
        { version_id: 'v4', public_id: 'A', record_hash: HASH_A_CHANGED },
      ],
    });

    await expect(findPublicationCompletionEvidence(supabase, 'A', head('v4', 4))).resolves.toBeNull();
  });

  it('returns nothing for a target that is not deployed at the head', async () => {
    const supabase = createSupabaseStub({ public_feed_versions: [], public_feed_version_members: [] });
    await expect(findPublicationCompletionEvidence(supabase, 'A', head('v4', 4))).resolves.toBeNull();
  });
});

describe('target-specific removal completion evidence', () => {
  it('returns project A removal evidence after an unrelated feed mutation', async () => {
    const supabase = createSupabaseStub({
      public_feed_versions: [
        { id: 'v3', version_number: 3, operation: 'removal', affected_public_id: 'A', operation_id: 'op-remove-A', published_snapshot_id: null, audit_record_id: 'audit-remove-A' },
        { id: 'v4', version_number: 4, operation: 'publication', affected_public_id: 'B', operation_id: 'op-B', published_snapshot_id: 'snap-B', audit_record_id: 'audit-B' },
      ],
      public_feed_version_members: [{ version_id: 'v4', public_id: 'B', record_hash: 'b'.repeat(64) }],
      public_feed_operations: [],
    });

    await expect(findRemovalCompletionEvidence(supabase, 'A', head('v4', 4))).resolves.toEqual({
      operationId: 'op-remove-A', versionNumber: 3, publishedSnapshotId: null, auditRecordId: 'audit-remove-A',
    });
  });

  it('rejects a removal that a later publication of the same target superseded', async () => {
    const supabase = createSupabaseStub({
      public_feed_versions: [
        { id: 'v3', version_number: 3, operation: 'removal', affected_public_id: 'A', operation_id: 'op-remove-A', published_snapshot_id: null, audit_record_id: 'audit-remove-A' },
        { id: 'v4', version_number: 4, operation: 'publication', affected_public_id: 'A', operation_id: 'op-republish-A', published_snapshot_id: 'snap-A2', audit_record_id: null },
      ],
      public_feed_version_members: [{ version_id: 'v4', public_id: 'A', record_hash: HASH_A }],
      public_feed_operations: [],
    });

    await expect(findRemovalCompletionEvidence(supabase, 'A', head('v5', 5))).resolves.toBeNull();
  });

  it('accepts a completed no-change removal whose bound candidate is exactly the current head', async () => {
    const supabase = createSupabaseStub({
      public_feed_versions: [],
      public_feed_version_members: [],
      public_feed_operations: [{
        id: 'op-nochange-A', kind: 'removal', public_id: 'A', state: 'COMPLETED',
        candidate_feed_hash: 'f'.repeat(64), candidate_record_count: 2,
        completed_at: '2026-08-24T02:00:00.000Z',
      }],
    });

    await expect(findRemovalCompletionEvidence(supabase, 'A', head('v4', 4))).resolves.toEqual({
      operationId: 'op-nochange-A', versionNumber: null, publishedSnapshotId: null, auditRecordId: null,
    });
  });

  it('refuses evidence when no completed removal matches the currently deployed bytes', async () => {
    const supabase = createSupabaseStub({
      public_feed_versions: [],
      public_feed_version_members: [],
      public_feed_operations: [{
        id: 'op-nochange-A', kind: 'removal', public_id: 'A', state: 'COMPLETED',
        candidate_feed_hash: 'e'.repeat(64), candidate_record_count: 9,
        completed_at: '2026-08-24T02:00:00.000Z',
      }],
    });

    await expect(findRemovalCompletionEvidence(supabase, 'A', head('v4', 4))).resolves.toBeNull();
  });
});
