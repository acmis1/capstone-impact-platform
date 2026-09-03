// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CorrectionPackage } from './participantCorrectionPackage';
import { correctionDigest } from './participantCorrectionPackage';
import { getParticipantCorrectionContext, stageParticipantCorrection } from './participantCorrectionService';

const ID = '11111111-1111-4111-8111-111111111111';
const PREFIX = `corrections/${ID}/${ID}/${ID}/`;
const CONTENT = Buffer.from('synthetic validated file bytes');
const candidate = {
  metadata: {
    publicId: '2026-synthetic', title: 'Synthetic correction', summary: 'Participant summary', background: '', solution: '',
    year: '2026', program: 'Information Technology', studyProgram: 'Information Technology', discipline: 'Software Engineering',
    industry: '', industryPartner: '', academicSupervisor: '', groupName: 'Synthetic team', participantContactEmail: '',
    teamMembers: ['Participant One'], layoutConfig: {},
  }, hash: 'a'.repeat(64), warnings: [], validationChecks: [], totalBytes: CONTENT.length,
  files: [{ role: 'poster_image', position: null, fileName: 'poster.png', mimeType: 'image/png', bytes: CONTENT.length, sha256: correctionDigest(CONTENT), altText: null, content: CONTENT }],
} as CorrectionPackage;

function backend() {
  const upload = vi.fn().mockResolvedValue({ error: null });
  const download = vi.fn().mockResolvedValue({ error: null, data: new Blob([CONTENT]) });
  const remove = vi.fn();
  const rpc = vi.fn().mockResolvedValueOnce({ error: null, data: { resultCode: 'SUCCESS', submissionId: ID, prefix: PREFIX, state: 'preparing' } }).mockResolvedValue({ error: null, data: { resultCode: 'SUCCESS' } });
  const table = vi.fn(() => { throw new Error('Authoritative tables must not be called'); });
  const bucket = vi.fn(() => ({ upload, download, remove }));
  return { client: { rpc, from: table, storage: { from: bucket } } as unknown as SupabaseClient, rpc, upload, download, remove, table, bucket };
}

describe('participant correction staging', () => {
  it('reserves first, uploads without overwrite, then completes; never writes authoritative tables', async () => {
    const b = backend();
    expect(await stageParticipantCorrection(b.client, 'b'.repeat(64), candidate)).toBe('submitted');
    expect(b.rpc.mock.calls[0][0]).toBe('reserve_participant_correction');
    expect(b.rpc.mock.calls[1][0]).toBe('complete_participant_correction');
    expect(b.upload).toHaveBeenCalledWith(PREFIX + 'poster_image.png', CONTENT, { contentType: 'image/png', upsert: false });
    expect(b.rpc.mock.invocationCallOrder[0]).toBeLessThan(b.upload.mock.invocationCallOrder[0]);
    expect(b.upload.mock.invocationCallOrder[0]).toBeLessThan(b.rpc.mock.invocationCallOrder[1]);
    expect(b.table).not.toHaveBeenCalled(); expect(b.remove).not.toHaveBeenCalled();
  });
  it('treats an exact submitted replay as idempotent without Storage writes', async () => {
    const b = backend(); b.rpc.mockReset().mockResolvedValue({ data: { resultCode: 'SUCCESS', submissionId: ID, prefix: PREFIX, state: 'submitted' }, error: null });
    expect(await stageParticipantCorrection(b.client, 'b'.repeat(64), candidate)).toBe('submitted');
    expect(b.upload).not.toHaveBeenCalled();
  });
  it.each(['LIMIT_REACHED', 'UNAVAILABLE', 'INVALID_PACKAGE'])('does not upload when reservation returns %s', async (resultCode) => {
    const b = backend(); b.rpc.mockReset().mockResolvedValue({ data: { resultCode }, error: null });
    expect(await stageParticipantCorrection(b.client, 'b'.repeat(64), candidate)).not.toBe('submitted');
    expect(b.upload).not.toHaveBeenCalled();
  });
  it('verifies identical existing bytes when concurrent uploads race', async () => {
    const b = backend(); b.upload.mockResolvedValue({ error: { message: 'backend error must not escape' } });
    expect(await stageParticipantCorrection(b.client, 'b'.repeat(64), candidate)).toBe('submitted');
    expect(b.download).toHaveBeenCalledWith(PREFIX + 'poster_image.png');
    expect(b.remove).not.toHaveBeenCalled();
  });
  it('rejects same-size different bytes and preserves the old object', async () => {
    const b = backend(); b.upload.mockResolvedValue({ error: {} });
    b.download.mockResolvedValue({ error: null, data: new Blob([Buffer.alloc(CONTENT.length)]) });
    expect(await stageParticipantCorrection(b.client, 'b'.repeat(64), candidate)).toBe('failed');
    expect(b.rpc).toHaveBeenCalledTimes(1); expect(b.remove).not.toHaveBeenCalled();
  });
  it('preserves bounded reserved objects after failed or uncertain DB finalization', async () => {
    const b = backend(); b.rpc.mockReset().mockResolvedValueOnce({ error: null, data: { resultCode: 'SUCCESS', submissionId: ID, prefix: PREFIX, state: 'preparing' } }).mockRejectedValue(new Error('private backend text'));
    expect(await stageParticipantCorrection(b.client, 'b'.repeat(64), candidate)).toBe('failed');
    expect(b.remove).not.toHaveBeenCalled(); expect(b.table).not.toHaveBeenCalled();
  });
  it('uses the same unavailable result for token failure, malformed responses and backend errors', async () => {
    const b = backend();
    for (const response of [{ data: { resultCode: 'UNAVAILABLE' } }, { data: { resultCode: 'SUCCESS' } }, { error: { message: 'secret backend text' } }]) {
      b.rpc.mockReset().mockResolvedValue(response);
      expect(await getParticipantCorrectionContext(b.client, 'b'.repeat(64))).toBeNull();
    }
  });
});
