import { describe, expect, it, vi } from 'vitest';

import {
  loadProjectMediaPreviewItems,
  ProjectMediaPreviewReadError,
  toProjectMediaPreviewItem,
  type ProjectMediaAssetPreviewRow,
} from './projectMediaPreview';

const privateRow: ProjectMediaAssetPreviewRow = {
  id: 'asset-private', asset_type: 'poster_image', file_name: 'poster.png',
  storage_bucket: 'draft-media', storage_path: 'drafts/private/poster.png', public_url: null,
  mime_type: 'image/png', file_size_bytes: 2048, is_public_approved: false,
};

describe('project media preview read model', () => {
  it('uses a private signed URL without exposing the private bucket or path', async () => {
    const signDraftMediaUrl = vi.fn().mockResolvedValue('https://local.example/signed-preview');
    const result = await toProjectMediaPreviewItem(privateRow, {
      projectTitle: 'Synthetic Project', accessibilityText: 'Authoritative poster description', privateBucket: 'draft-media', signDraftMediaUrl,
    });

    expect(signDraftMediaUrl).toHaveBeenCalledWith({ storageBucket: 'draft-media', storagePath: 'drafts/private/poster.png' });
    expect(result).toEqual(expect.objectContaining({ id: 'asset-private', assetType: 'poster_image', fileName: 'poster.png', mimeType: 'image/png', fileSize: 2048, url: 'https://local.example/signed-preview', previewSource: 'private-signed', altText: 'Authoritative poster description' }));
    expect(JSON.stringify(result)).not.toContain('drafts/private');
    expect(JSON.stringify(result)).not.toContain('draft-media');
  });

  it('retains metadata but fails closed when signing fails', async () => {
    const result = await toProjectMediaPreviewItem(privateRow, {
      projectTitle: 'Synthetic Project', privateBucket: 'draft-media', signDraftMediaUrl: vi.fn().mockResolvedValue(null),
    });
    expect(result).toEqual(expect.objectContaining({ fileName: 'poster.png', mimeType: 'image/png', fileSize: 2048, previewSource: 'unavailable' }));
    expect(result.url).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('storage_path');
  });

  it('uses only a valid authoritative public URL for approved media', async () => {
    const result = await toProjectMediaPreviewItem({ ...privateRow, id: 'asset-public', is_public_approved: true, public_url: 'https://assets.example/public/poster.png' }, {
      projectTitle: 'Synthetic Project', privateBucket: 'draft-media', signDraftMediaUrl: vi.fn(),
    });
    expect(result).toEqual(expect.objectContaining({ url: 'https://assets.example/public/poster.png', previewSource: 'public' }));
  });

  it.each(['javascript:alert(1)', 'not a url'])('rejects an invalid approved public URL: %s', async (publicUrl) => {
    const result = await toProjectMediaPreviewItem({ ...privateRow, is_public_approved: true, public_url: publicUrl }, {
      projectTitle: 'Synthetic Project', privateBucket: 'draft-media', signDraftMediaUrl: vi.fn(),
    });
    expect(result.url).toBeUndefined();
    expect(result.previewSource).toBe('unavailable');
  });

  it('queries the exact project UUID with deterministic ordering', async () => {
    const chain: Record<string, unknown> = {};
    const order = vi.fn();
    Object.assign(chain, { select: vi.fn(() => chain), eq: vi.fn(() => chain), order });
    order.mockReturnValueOnce(chain).mockReturnValueOnce(chain).mockResolvedValueOnce({ data: [privateRow], error: null });
    const supabase = { from: vi.fn(() => chain) } as never;

    const result = await loadProjectMediaPreviewItems({ supabase, projectId: 'project-uuid', projectTitle: 'Synthetic Project', privateBucket: 'draft-media', signDraftMediaUrl: vi.fn().mockResolvedValue(null) });
    expect(result).toHaveLength(1);
    expect((chain.eq as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('project_id', 'project-uuid');
    expect(order).toHaveBeenNthCalledWith(1, 'asset_type', { ascending: true });
    expect(order).toHaveBeenNthCalledWith(2, 'created_at', { ascending: true });
    expect(order).toHaveBeenNthCalledWith(3, 'id', { ascending: true });
  });

  it('reports a media read failure without producing an empty-media result', async () => {
    const chain: Record<string, unknown> = {};
    const order = vi.fn();
    Object.assign(chain, { select: vi.fn(() => chain), eq: vi.fn(() => chain), order });
    order.mockReturnValueOnce(chain).mockReturnValueOnce(chain).mockResolvedValueOnce({ data: null, error: { message: 'unavailable' } });
    await expect(loadProjectMediaPreviewItems({ supabase: { from: vi.fn(() => chain) } as never, projectId: 'project-uuid', projectTitle: 'Synthetic Project', privateBucket: 'draft-media' })).rejects.toBeInstanceOf(ProjectMediaPreviewReadError);
  });
});
