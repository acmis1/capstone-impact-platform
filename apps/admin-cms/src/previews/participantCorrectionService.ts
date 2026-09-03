import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { correctionDigest, type CorrectionPackage } from './participantCorrectionPackage';

export const PARTICIPANT_CORRECTION_BUCKET = 'participant-corrections-private';

const contextSchema = z.object({
  resultCode: z.literal('SUCCESS'), publicId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  projectId: z.uuid(), previewId: z.uuid(), correctionId: z.uuid(), submitted: z.boolean(), canSubmit: z.boolean(),
});
export type CorrectionContext = z.infer<typeof contextSchema>;

export async function getParticipantCorrectionContext(client: SupabaseClient, tokenHash: string): Promise<CorrectionContext | null> {
  try {
    const { data, error } = await client.rpc('participant_correction_context', { p_token_hash: tokenHash });
    const parsed = contextSchema.safeParse(data);
    return error || !parsed.success ? null : parsed.data;
  } catch { return null; }
}

const reservationSchema = z.object({
  resultCode: z.literal('SUCCESS'), submissionId: z.uuid(), state: z.enum(['preparing', 'submitted']),
  prefix: z.string().regex(/^corrections\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/$/),
});

/** Files are generated under a durable, quota-counted reservation. Never overwrite or delete. */
export async function stageParticipantCorrection(client: SupabaseClient, tokenHash: string, candidate: CorrectionPackage): Promise<'submitted' | 'limit' | 'lookup' | 'failed'> {
  const bucket = PARTICIPANT_CORRECTION_BUCKET;
  const files = candidate.files.map(({ content: _content, ...file }) => ({
    ...file, storageName: `${file.role}${file.position === null ? '' : `-${file.position}`}.${file.fileName.split('.').pop()!.toLowerCase()}`,
  }));
  try {
    const reserved = await client.rpc('reserve_participant_correction', {
      p_token_hash: tokenHash, p_package_hash: candidate.hash, p_metadata: candidate.metadata,
      p_files: files, p_warnings: candidate.warnings, p_bucket: bucket,
    });
    if (reserved.error) return 'failed';
    if (reserved.data?.resultCode === 'LIMIT_REACHED') return 'limit';
    if (reserved.data?.resultCode === 'LOOKUP_INVALID') return 'lookup';
    const result = reservationSchema.safeParse(reserved.data);
    if (!result.success) return 'failed';
    const reservation = result.data;
    if (!reservation.prefix.endsWith(`/${reservation.submissionId}/`)) return 'failed';
    if (reservation.state === 'submitted') return 'submitted';
    for (const [i, file] of files.entries()) {
      const destination = reservation.prefix + file.storageName;
      const { error } = await client.storage.from(bucket).upload(destination, candidate.files[i].content, { contentType: file.mimeType, upsert: false });
      if (error) {
        // A concurrent/retried upload may already own the same immutable bytes. Error text is
        // never interpreted, returned or logged. Prove identity using downloaded bytes instead.
        const existing = await client.storage.from(bucket).download(destination);
        if (existing.error || !existing.data || existing.data.size !== file.bytes || correctionDigest(Buffer.from(await existing.data.arrayBuffer())) !== file.sha256) return 'failed';
      }
    }
    const completed = await client.rpc('complete_participant_correction', {
      p_token_hash: tokenHash, p_submission_id: reservation.submissionId, p_package_hash: candidate.hash,
    });
    return !completed.error && completed.data?.resultCode === 'SUCCESS' ? 'submitted' : 'failed';
  } catch {
    // Do not delete: another attempt may depend on these objects or finalization may have
    // committed despite a lost response. The reservation caps residue and makes retry safe.
    return 'failed';
  }
}
