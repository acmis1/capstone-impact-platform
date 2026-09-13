import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { readPreviewAccessEvidence, recordPreviewResponsePrepared } from './participantPreviewAccessEvidence';

const id = '12345678-1234-4234-8234-123456789012';
const hash = 'a'.repeat(64);
function boundary(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  const maybeSingle = vi.fn().mockResolvedValue({ data, error });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { rpc, from } as unknown as SupabaseClient, rpc, from, select, eq, maybeSingle };
}

describe('preview response-preparation evidence repository boundary', () => {
  it('sends only a server-resolved preview identity and token hash, never a browser timestamp', async () => {
    const b = boundary({ resultCode: 'OBSERVED' });
    expect(await recordPreviewResponsePrepared(b.client, id, hash)).toBe(true);
    expect(b.rpc).toHaveBeenCalledExactlyOnceWith('record_participant_preview_response_prepared', {
      p_preview_id: id, p_token_hash: hash,
    });
    expect(b.from).not.toHaveBeenCalled();
  });
  it('retains a generic not-found result for a capability lost after rendering', async () => {
    expect(await recordPreviewResponsePrepared(boundary({ resultCode: 'NOT_FOUND' }).client, id, hash)).toBe(false);
  });
  it.each([null, [], 'OBSERVED', {}, { resultCode: 'SUCCESS' }])('rejects malformed evidence acknowledgement %j', async (data) => {
    await expect(recordPreviewResponsePrepared(boundary(data).client, id, hash)).rejects.toThrow('PREVIEW_ACCESS_EVIDENCE_UNAVAILABLE');
  });
  it('does not leak provider error text', async () => {
    await expect(recordPreviewResponsePrepared(boundary(null, { message: 'synthetic private failure' }).client, id, hash))
      .rejects.toThrow(/^PREVIEW_ACCESS_EVIDENCE_UNAVAILABLE$/);
  });
  it.each([['bad', hash], [id, 'bad'], [id, 'a'.repeat(65)], [id, 'A'.repeat(64)]])(
    'rejects malformed capability parameters before any RPC', async (previewId, tokenHash) => {
      const b = boundary({ resultCode: 'OBSERVED' });
      await expect(recordPreviewResponsePrepared(b.client, previewId, tokenHash)).rejects.toThrow();
      expect(b.rpc).not.toHaveBeenCalled();
    },
  );
});

describe('staff access-evidence reading', () => {
  it('distinguishes no observation from an unavailable read', async () => {
    expect(await readPreviewAccessEvidence(boundary(null).client, id)).toEqual({ available: true, firstResponsePreparedAt: null });
    expect(await readPreviewAccessEvidence(boundary(null, { message: 'private' }).client, id)).toEqual({ available: false });
  });
  it('returns only bounded evidence for the exact requested preview', async () => {
    const timestamp = '2026-09-10T00:00:00.123456+00:00';
    const b = boundary({ participant_preview_id: id, first_response_prepared_at: timestamp });
    expect(await readPreviewAccessEvidence(b.client, id)).toEqual({ available: true, firstResponsePreparedAt: timestamp });
    expect(b.select).toHaveBeenCalledWith('participant_preview_id,first_response_prepared_at');
    expect(b.eq).toHaveBeenCalledWith('participant_preview_id', id);
  });
  it.each([
    { participant_preview_id: 'another-preview', first_response_prepared_at: '2026-09-10T00:00:00Z' },
    { participant_preview_id: id, first_response_prepared_at: 'not-a-date' },
    { participant_preview_id: id, first_response_prepared_at: null },
    { participant_preview_id: id, first_response_prepared_at: '2026-09-10T' + 'x'.repeat(100) },
  ])('does not promote malformed or mismatched evidence into a successful read', async (data) => {
    expect(await readPreviewAccessEvidence(boundary(data).client, id)).toEqual({ available: false });
  });
  it('rejects an invalid preview identity without querying', async () => {
    const b = boundary(null);
    expect(await readPreviewAccessEvidence(b.client, 'bad')).toEqual({ available: false });
    expect(b.from).not.toHaveBeenCalled();
  });
});
