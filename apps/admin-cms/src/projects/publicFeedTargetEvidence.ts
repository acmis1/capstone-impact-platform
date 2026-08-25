import type { SupabaseClient } from '@supabase/supabase-js';
import type { PublicFeedHeadRecord } from '../repositories/SupabasePublicFeedLedgerRepositoryCore';

/**
 * Two different questions are deliberately answered by two different sources.
 *
 * The current head answers "is this publicId currently deployed?". It says nothing about which
 * operation put it there: after any later feed mutation, or after a rollback, the head belongs to
 * a different operation entirely. Completion evidence for one target must therefore come from the
 * immutable per-target ledger history, never from whatever operation happens to own the head.
 *
 * Every lookup here is bounded and scoped to a single publicId.
 */

export interface PublicFeedTargetEvidence {
  operationId: string;
  versionNumber: number | null;
  publishedSnapshotId: string | null;
  auditRecordId: string | null;
}

interface VersionRow {
  id: string;
  versionNumber: number;
  operationId: string;
  publishedSnapshotId: string | null;
  auditRecordId: string | null;
}

function versionRows(rows: Record<string, unknown>[]): VersionRow[] {
  return rows.map((row) => ({
    id: String(row.id),
    versionNumber: Number(row.version_number),
    operationId: String(row.operation_id),
    publishedSnapshotId: row.published_snapshot_id === null ? null : String(row.published_snapshot_id),
    auditRecordId: row.audit_record_id === null ? null : String(row.audit_record_id),
  }));
}

async function readTargetVersions(
  supabase: SupabaseClient,
  operation: 'publication' | 'removal',
  publicId: string,
  headVersionNumber: number,
  limit: number,
): Promise<VersionRow[]> {
  const result = await supabase.from('public_feed_versions')
    .select('id,version_number,operation_id,published_snapshot_id,audit_record_id')
    .eq('operation', operation)
    .eq('affected_public_id', publicId)
    .lte('version_number', headVersionNumber)
    .order('version_number', { ascending: false })
    .limit(limit);
  if (result.error) throw new Error('PUBLIC_FEED_TARGET_HISTORY_READ_FAILED');
  return versionRows((result.data ?? []) as Record<string, unknown>[]);
}

async function readMemberRecordHash(
  supabase: SupabaseClient,
  versionId: string,
  publicId: string,
): Promise<string | null> {
  const result = await supabase.from('public_feed_version_members')
    .select('record_hash').eq('version_id', versionId).eq('public_id', publicId).maybeSingle();
  if (result.error) throw new Error('PUBLIC_FEED_TARGET_MEMBER_READ_FAILED');
  return result.data ? String(result.data.record_hash) : null;
}

async function readMatchingPublication(
  supabase: SupabaseClient,
  publicId: string,
  deployedRecordHash: string,
  headVersionNumber: number,
): Promise<VersionRow | null> {
  const result = await supabase.from('public_feed_versions')
    .select('id,version_number,operation_id,published_snapshot_id,audit_record_id,public_feed_version_members!inner(record_hash)')
    .eq('operation', 'publication')
    .eq('affected_public_id', publicId)
    .eq('public_feed_version_members.public_id', publicId)
    .eq('public_feed_version_members.record_hash', deployedRecordHash)
    .lte('version_number', headVersionNumber)
    .order('version_number', { ascending: false })
    .limit(1);
  if (result.error) throw new Error('PUBLIC_FEED_TARGET_HISTORY_READ_FAILED');
  const rows = versionRows((result.data ?? []) as Record<string, unknown>[]);
  return rows[0] ?? null;
}

/**
 * Completion evidence for a publication of `publicId`, resolved from the publication versions that
 * named this exact target. The winning version must have deployed byte-identical record bytes to
 * the ones currently at the head, which is what keeps a rollback honest: a restored head only
 * matches the publication that actually produced those bytes.
 *
 * Returns null when the target is deployed but no publication version explains the deployed bytes.
 * Callers must surface that as an explicit no-change result rather than substituting head metadata.
 */
export async function findPublicationCompletionEvidence(
  supabase: SupabaseClient,
  publicId: string,
  head: PublicFeedHeadRecord,
): Promise<PublicFeedTargetEvidence | null> {
  const deployedRecordHash = await readMemberRecordHash(supabase, head.currentVersion.id, publicId);
  if (deployedRecordHash === null) return null;
  const match = await readMatchingPublication(
    supabase, publicId, deployedRecordHash, head.currentVersion.versionNumber,
  );
  if (!match) return null;
  return {
    operationId: match.operationId, versionNumber: match.versionNumber,
    publishedSnapshotId: match.publishedSnapshotId, auditRecordId: match.auditRecordId,
  };
}

/**
 * Completion evidence for a removal of `publicId`, resolved from the removal versions that named
 * this exact target. A removal that is followed by a later publication of the same target no longer
 * explains the current absence — that absence came from somewhere else (a rollback, typically) — so
 * the stale removal is rejected instead of being reported as this request's completion.
 *
 * A removal of a target that was already absent legitimately writes no version, so completed
 * removal operations whose bound candidate is byte-identical to the current head are accepted as a
 * second, equally target-specific source.
 */
export async function findRemovalCompletionEvidence(
  supabase: SupabaseClient,
  publicId: string,
  head: PublicFeedHeadRecord,
): Promise<PublicFeedTargetEvidence | null> {
  const removals = await readTargetVersions(supabase, 'removal', publicId, head.currentVersion.versionNumber, 1);
  if (removals.length === 1) {
    const removal = removals[0];
    const laterPublications = await supabase.from('public_feed_versions')
      .select('version_number').eq('operation', 'publication').eq('affected_public_id', publicId)
      .gt('version_number', removal.versionNumber)
      .lte('version_number', head.currentVersion.versionNumber).limit(1);
    if (laterPublications.error) throw new Error('PUBLIC_FEED_TARGET_HISTORY_READ_FAILED');
    if ((laterPublications.data ?? []).length === 0) {
      return {
        operationId: removal.operationId, versionNumber: removal.versionNumber,
        publishedSnapshotId: removal.publishedSnapshotId, auditRecordId: removal.auditRecordId,
      };
    }
  }

  const completed = await supabase.from('public_feed_operations')
    .select('id,completed_at').eq('kind', 'removal').eq('public_id', publicId).eq('state', 'COMPLETED')
    .eq('candidate_feed_hash', head.currentVersion.feedHash)
    .eq('candidate_record_count', head.currentVersion.recordCount)
    .order('completed_at', { ascending: false }).limit(1);
  if (completed.error) throw new Error('PUBLIC_FEED_TARGET_OPERATION_READ_FAILED');
  const operation = (completed.data ?? [])[0];
  if (!operation) return null;
  return {
    operationId: String(operation.id), versionNumber: null,
    publishedSnapshotId: null, auditRecordId: null,
  };
}
