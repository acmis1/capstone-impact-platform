import type { SupabaseClient } from '@supabase/supabase-js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const UNAVAILABLE = 'PREVIEW_ACCESS_EVIDENCE_UNAVAILABLE';

export type PreviewAccessEvidence =
  | { available: false }
  | { available: true; firstResponsePreparedAt: string | null };

/** Records only that the server prepared a complete preview response. No delivery/read claim. */
export async function recordPreviewResponsePrepared(
  client: SupabaseClient,
  previewId: string,
  tokenHash: string,
): Promise<boolean> {
  if (!UUID.test(previewId) || !HASH.test(tokenHash)) throw new Error(UNAVAILABLE);
  const { data, error } = await client.rpc('record_participant_preview_response_prepared', {
    p_preview_id: previewId, p_token_hash: tokenHash,
  });
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error(UNAVAILABLE);
  if (data.resultCode === 'NOT_FOUND') return false;
  if (data.resultCode !== 'OBSERVED') throw new Error(UNAVAILABLE);
  return true;
}

/** Staff-only caller must establish project-read authorization before requesting this evidence. */
export async function readPreviewAccessEvidence(
  client: SupabaseClient,
  previewId: string,
): Promise<PreviewAccessEvidence> {
  if (!UUID.test(previewId)) return { available: false };
  try {
    const { data, error } = await client.from('participant_preview_access_observations')
      .select('participant_preview_id,first_response_prepared_at')
      .eq('participant_preview_id', previewId).maybeSingle();
    if (error) return { available: false };
    if (!data) return { available: true, firstResponsePreparedAt: null };
    const timestamp: unknown = data.first_response_prepared_at;
    if (data.participant_preview_id !== previewId || typeof timestamp !== 'string'
        || timestamp.length > 64 || !/^\d{4}-\d{2}-\d{2}T/.test(timestamp)
        || !Number.isFinite(Date.parse(timestamp))) return { available: false };
    return { available: true, firstResponsePreparedAt: timestamp };
  } catch {
    return { available: false };
  }
}
