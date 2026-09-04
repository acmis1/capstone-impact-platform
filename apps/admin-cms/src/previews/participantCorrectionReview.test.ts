import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { correctionForm } from './participantCorrectionFixtures';
import { parseParticipantCorrectionPackage, type CorrectionPackage } from './participantCorrectionPackage';
import { decideParticipantCorrection } from './participantCorrectionReview';

const id = '22222222-2222-4222-8222-222222222222';
const version = 'b'.repeat(64);
let candidate: CorrectionPackage;
beforeEach(async () => { candidate = await parseParticipantCorrectionPackage(await correctionForm(), '2026-synthetic'); });
function boundary(state = 'frozen') {
  const stored = { id, project_id: '33333333-3333-4333-8333-333333333333', correction_request_id: '44444444-4444-4444-8444-444444444444', participant_preview_id: '55555555-5555-4555-8555-555555555555',
    source: 'participant_capability', base_version: null, validation_checks: candidate.validationChecks, package_hash: candidate.hash, metadata: candidate.metadata, warnings: candidate.warnings, state, frozen_at: '2026-09-03T00:00:00Z', submitted_at: '2026-09-03T00:00:00Z', frozen_version: version,
    storage_bucket: 'participant-corrections-private', files: candidate.files.map(({ role, position, fileName, mimeType, bytes, sha256, altText }) => ({ role, position, fileName, mimeType, bytes, sha256, altText, storageName: `${role}${position === null ? '' : `-${position}`}.${fileName.split('.').at(-1)}` })) };
  const upload = vi.fn().mockResolvedValue({ error: null });
  const remove = vi.fn();
  const download = vi.fn(async (path: string) => {
    const index = stored.files.findIndex((f) => path.endsWith(`/${f.storageName}`) || path.endsWith(`/${f.storageName}/${f.fileName}`));
    return { data: new Blob([new Uint8Array(candidate.files[index].content)]), error: null };
  });
  const rpc = vi.fn(async (name: string) => ({ data: name === 'participant_correction_project_version' ? version : { resultCode: 'SUCCESS' }, error: null }));
  const from = vi.fn((table: string) => {
    const chain = { select: () => chain, eq: () => chain, is: () => chain, single: async () => ({ data: table === 'projects' ? { id: stored.project_id } : stored, error: null }) };
    return chain;
  });
  return { client: { from, rpc, storage: { from: () => ({ upload, download, remove }) } } as unknown as SupabaseClient, stored, upload, download, remove, rpc, from };
}
const decision = () => ({ action: 'accept' as const, submissionId: id, packageHash: candidate.hash, expectedVersion: version });
describe('exact participant revision acceptance service', () => {
  it('verifies actual candidate bytes, writes unique copies without upsert, verifies copies and sends only identity to acceptance', async () => {
    const b = boundary();
    expect(await decideParticipantCorrection(b.client, '2026-synthetic', 'staff-session', decision())).toEqual({ success: true, code: 'SUCCESS' });
    expect(b.download).toHaveBeenCalledTimes(7); expect(b.upload).toHaveBeenCalledTimes(3);
    for (const [path, , options] of b.upload.mock.calls) {
      expect(path).toMatch(/^drafts\/2026-synthetic\/(poster_image|poster_pdf|snapshot_image)\/corrections\//);
      expect(options.upsert).toBe(false);
    }
    expect(b.rpc).toHaveBeenLastCalledWith('review_participant_correction', { p_public_id: '2026-synthetic', p_admin_id: 'staff-session', p_submission_id: id, p_package_hash: candidate.hash, p_expected_version: version, p_action: 'accept' });
    expect(b.remove).not.toHaveBeenCalled();
  });
  it('reuses a byte-identical prepared copy after an uncertain upload', async () => {
    const b = boundary(); b.upload.mockResolvedValue({ error: { message: 'uncertain transport' } } as never);
    expect((await decideParticipantCorrection(b.client, '2026-synthetic', 'staff', decision())).success).toBe(true);
    expect(b.remove).not.toHaveBeenCalled();
  });
  it('rejects a changed candidate before any draft copy or acceptance', async () => {
    const b = boundary(); b.download.mockResolvedValueOnce({ data: new Blob([new Uint8Array(candidate.files[0].bytes)]), error: null });
    expect((await decideParticipantCorrection(b.client, '2026-synthetic', 'staff', decision())).success).toBe(false);
    expect(b.upload).not.toHaveBeenCalled(); expect(b.rpc).not.toHaveBeenCalledWith('review_participant_correction', expect.anything());
  });
  it('rejects a corrupt copy and retains objects for a safe retry', async () => {
    const b = boundary(); const original = b.download.getMockImplementation()!;
    b.download.mockImplementation(async (path) => path.startsWith('drafts/') ? { data: new Blob([new Uint8Array(candidate.files[1].bytes)]), error: null } : original(path));
    expect((await decideParticipantCorrection(b.client, '2026-synthetic', 'staff', decision())).success).toBe(false);
    expect(b.rpc).not.toHaveBeenCalledWith('review_participant_correction', expect.anything()); expect(b.remove).not.toHaveBeenCalled();
  });
  it('rejects a stale project version before copying', async () => {
    const b = boundary();
    expect(await decideParticipantCorrection(b.client, '2026-synthetic', 'staff', { ...decision(), expectedVersion: 'c'.repeat(64) })).toEqual({ success: false, code: 'STALE_REVISION' });
    expect(b.download).not.toHaveBeenCalled(); expect(b.upload).not.toHaveBeenCalled();
  });
  it('replays an accepted receipt without downloading or writing any object', async () => {
    const b = boundary('accepted');
    expect((await decideParticipantCorrection(b.client, '2026-synthetic', 'staff', decision())).success).toBe(true);
    expect(b.download).not.toHaveBeenCalled(); expect(b.upload).not.toHaveBeenCalled(); expect(b.remove).not.toHaveBeenCalled();
  });
  it('rejects a direct replacement-value override before reading data', async () => {
    const b = boundary();
    expect((await decideParticipantCorrection(b.client, '2026-synthetic', 'staff', { ...decision(), metadata: { title: 'Staff replacement' } } as never)).success).toBe(false);
    expect(b.from).not.toHaveBeenCalled(); expect(b.rpc).not.toHaveBeenCalled();
  });
});
