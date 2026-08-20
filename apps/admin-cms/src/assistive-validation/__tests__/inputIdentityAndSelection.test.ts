import { describe, expect, it, vi } from 'vitest';

import { hashAssistiveInput } from '../domain/inputIdentity';
import type { AssistiveInputGateway } from '../repositories/assistiveInputRepository';
import { loadAssistiveInput } from '../services/assistiveInputService';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);
const PDF = Buffer.from('%PDF-1.4\n', 'ascii');

describe('assistive input identity and private poster selection', () => {
  it('hashes exact bytes, title, and detected document type deterministically', () => {
    const first = hashAssistiveInput({ title: 'Exact title', documentType: 'PDF', content: PDF });
    const repeat = hashAssistiveInput({ title: 'Exact title', documentType: 'PDF', content: PDF });
    expect(first).toEqual(repeat);
    expect(first.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.documentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashAssistiveInput({ title: 'Changed', documentType: 'PDF', content: PDF }).inputHash)
      .not.toBe(first.inputHash);
    expect(hashAssistiveInput({ title: 'Exact title', documentType: 'PNG', content: PDF }).inputHash)
      .not.toBe(first.inputHash);
    expect(hashAssistiveInput({ title: 'Exact title', documentType: 'PDF', content: Buffer.concat([PDF, Buffer.from('x')]) }).inputHash)
      .not.toBe(first.inputHash);
  });

  it('prefers the private poster PDF and validates its exact metadata and bytes', async () => {
    const gateway: AssistiveInputGateway = {
      loadProject: vi.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', public_id: 'P-1', title: 'Title' }),
      loadPosterAssets: vi.fn().mockResolvedValue([
        { id: '22222222-2222-4222-8222-222222222222', asset_type: 'poster_image', file_name: 'poster.png', storage_bucket: 'private', storage_path: 'drafts/P-1/poster_image/poster.png', mime_type: 'image/png', file_size_bytes: PNG.length, created_at: '2026-08-20T00:00:00Z' },
        { id: '33333333-3333-4333-8333-333333333333', asset_type: 'poster_pdf', file_name: 'poster.pdf', storage_bucket: 'private', storage_path: 'drafts/P-1/poster_pdf/poster.pdf', mime_type: 'application/pdf', file_size_bytes: PDF.length, created_at: '2026-08-19T00:00:00Z' },
      ]),
      download: vi.fn().mockResolvedValue(PDF),
    };
    const result = await loadAssistiveInput(gateway, '11111111-1111-4111-8111-111111111111', 'private');
    expect(result?.documentType).toBe('PDF');
    expect(result?.assetId).toBe('33333333-3333-4333-8333-333333333333');
    expect(gateway.download).toHaveBeenCalledWith('private', 'drafts/P-1/poster_pdf/poster.pdf');
  });

  it('fails closed for an unsafe path, unsupported type, or byte mismatch', async () => {
    const base = {
      id: '22222222-2222-4222-8222-222222222222',
      asset_type: 'poster_image' as const,
      file_name: 'poster.png', storage_bucket: 'private',
      storage_path: 'drafts/P-1/poster_image/poster.png', mime_type: 'image/png',
      file_size_bytes: PNG.length, created_at: '2026-08-20T00:00:00Z',
    };
    const gateway: AssistiveInputGateway = {
      loadProject: vi.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', public_id: 'P-1', title: 'Title' }),
      loadPosterAssets: vi.fn(),
      download: vi.fn().mockResolvedValue(PDF),
    };
    for (const asset of [
      { ...base, storage_path: '../poster.png' },
      { ...base, mime_type: 'image/webp' },
      base,
    ]) {
      vi.mocked(gateway.loadPosterAssets).mockResolvedValueOnce([asset]);
      await expect(loadAssistiveInput(gateway, '11111111-1111-4111-8111-111111111111', 'private'))
        .resolves.toBeNull();
    }
  });
});
