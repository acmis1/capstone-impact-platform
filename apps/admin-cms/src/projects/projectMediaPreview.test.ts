import { describe, expect, it, vi } from 'vitest';

import {
  compareProjectMediaDisplayOrder,
  deriveApprovalMediaInput,
  loadProjectMediaPreviewItems,
  ProjectMediaPreviewReadError,
  toProjectMediaPreviewItem,
  type ProjectMediaAssetPreviewRow,
} from './projectMediaPreview';

const privateRow: ProjectMediaAssetPreviewRow = {
  id: 'asset-private', asset_type: 'poster_image', gallery_position: null, file_name: 'poster.png',
  storage_bucket: 'draft-media', storage_path: 'drafts/private/poster.png', public_url: null,
  public_storage_bucket: null, public_storage_path: null,
  mime_type: 'image/png', file_size_bytes: 2048, is_public_approved: false, alt_text_public: null,
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

  it('queries the exact project UUID and applies the Admin display ordering centrally', async () => {
    const chain: Record<string, unknown> = {};
    const order = vi.fn();
    Object.assign(chain, { select: vi.fn(() => chain), eq: vi.fn(() => chain), order });
    order.mockResolvedValueOnce({ data: [privateRow], error: null });
    const supabase = { from: vi.fn(() => chain) } as never;

    const result = await loadProjectMediaPreviewItems({ supabase, projectId: 'project-uuid', projectPublicId: 'private', projectTitle: 'Synthetic Project', privateBucket: 'draft-media', signDraftMediaUrl: vi.fn().mockResolvedValue(null) });
    expect(result).toHaveLength(1);
    expect((chain.eq as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('project_id', 'project-uuid');
    expect(order).toHaveBeenCalledWith('id', { ascending: true });
  });

  it('orders the preview read model by fixed media role then numeric gallery position, not input order', async () => {
    const rows: ProjectMediaAssetPreviewRow[] = [
      { ...privateRow, id: 'snapshot-c', asset_type: 'snapshot_image', gallery_position: 3, file_name: 'snapshot-3.png', storage_path: 'drafts/private/snapshot_image/snapshot-3.png', alt_text_public: 'Snapshot three.' },
      { ...privateRow, id: 'poster-image', asset_type: 'poster_image', gallery_position: null, storage_path: 'drafts/private/poster_image/poster.png' },
      { ...privateRow, id: 'poster-pdf', asset_type: 'poster_pdf', gallery_position: null, file_name: 'poster.pdf', storage_path: 'drafts/private/poster_pdf/poster.pdf', mime_type: 'application/pdf' },
      { ...privateRow, id: 'snapshot-a', asset_type: 'snapshot_image', gallery_position: 1, file_name: 'snapshot-1.png', storage_path: 'drafts/private/snapshot_image/snapshot-1.png', alt_text_public: 'Snapshot one.' },
      { ...privateRow, id: 'snapshot-b', asset_type: 'snapshot_image', gallery_position: 2, file_name: 'snapshot-2.png', storage_path: 'drafts/private/snapshot_image/snapshot-2.png', alt_text_public: 'Snapshot two.' },
    ];
    const chain: Record<string, unknown> = {};
    const order = vi.fn();
    Object.assign(chain, { select: vi.fn(() => chain), eq: vi.fn(() => chain), order });
    order.mockResolvedValueOnce({ data: rows, error: null });

    const result = await loadProjectMediaPreviewItems({
      supabase: { from: vi.fn(() => chain) } as never,
      projectId: 'project-uuid',
      projectPublicId: 'private',
      projectTitle: 'Synthetic Project',
      privateBucket: 'draft-media',
      signDraftMediaUrl: vi.fn().mockResolvedValue(null),
    });

    expect(result.map((item) => item.id)).toEqual([
      'poster-image', 'poster-pdf', 'snapshot-a', 'snapshot-b', 'snapshot-c',
    ]);
  });

  it('places malformed snapshot positions after valid positions with an ID tie-breaker', () => {
    const rows = [
      { id: 'snapshot-null', asset_type: 'snapshot_image', gallery_position: null },
      { id: 'snapshot-three', asset_type: 'snapshot_image', gallery_position: 3 },
      { id: 'snapshot-one', asset_type: 'snapshot_image', gallery_position: 1 },
    ];

    expect([...rows].sort(compareProjectMediaDisplayOrder).map((row) => row.id)).toEqual([
      'snapshot-one', 'snapshot-three', 'snapshot-null',
    ]);
  });

  it('reports a media read failure without producing an empty-media result', async () => {
    const chain: Record<string, unknown> = {};
    const order = vi.fn();
    Object.assign(chain, { select: vi.fn(() => chain), eq: vi.fn(() => chain), order });
    order.mockResolvedValueOnce({ data: null, error: { message: 'unavailable' } });
    await expect(loadProjectMediaPreviewItems({ supabase: { from: vi.fn(() => chain) } as never, projectId: 'project-uuid', projectPublicId: 'private', projectTitle: 'Synthetic Project', privateBucket: 'draft-media' })).rejects.toBeInstanceOf(ProjectMediaPreviewReadError);
  });

  it('derives exact private approval evidence without exposing storage locations', () => {
    const posterPdf: ProjectMediaAssetPreviewRow = {
      ...privateRow,
      id: 'asset-pdf',
      asset_type: 'poster_pdf',
      file_name: 'poster.pdf',
      storage_path: 'drafts/private/poster_pdf/poster.pdf',
      mime_type: 'application/pdf',
    };
    const result = deriveApprovalMediaInput([
      { ...privateRow, storage_path: 'drafts/private/poster_image/poster.png' },
      posterPdf,
    ], { projectPublicId: 'private', privateBucket: 'draft-media' });

    expect(result).toEqual({
      posterImage: { rowCount: 1, validPrivateCount: 1 },
      posterPdf: { rowCount: 1, validPrivateCount: 1 },
      snapshotMedia: [],
    });
    expect(JSON.stringify(result)).not.toContain('drafts/private');
    expect(JSON.stringify(result)).not.toContain('draft-media');
  });

  it('marks wrong-project paths, public state, and malformed metadata invalid', () => {
    const result = deriveApprovalMediaInput([
      { ...privateRow, storage_path: 'drafts/foreign/poster_image/poster.png' },
      {
        ...privateRow,
        id: 'asset-pdf',
        asset_type: 'poster_pdf',
        file_name: 'poster.pdf',
        storage_path: 'drafts/private/poster_pdf/poster.pdf',
        mime_type: 'application/pdf',
        is_public_approved: true,
        public_url: 'https://assets.example/poster.pdf',
        public_storage_bucket: 'project-public-assets',
        public_storage_path: 'published/private/poster_pdf/poster.pdf',
      },
    ], { projectPublicId: 'private', privateBucket: 'draft-media' });

    expect(result.posterImage).toEqual({ rowCount: 1, validPrivateCount: 0 });
    expect(result.posterPdf).toEqual({ rowCount: 1, validPrivateCount: 0 });
  });
});
