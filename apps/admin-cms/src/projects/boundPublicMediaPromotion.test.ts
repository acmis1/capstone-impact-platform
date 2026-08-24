import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  promoteBoundPublicMedia,
  validateBoundPublicMedia,
  type BoundPublicMediaStorage,
} from './boundPublicMediaPromotion';
import type { PublicationMediaBinding } from './publicationArtifact';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const OTHER_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 1, 1, 1]);

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function binding(index: number, overrides: Partial<PublicationMediaBinding> = {}): PublicationMediaBinding {
  return {
    mediaAssetId: `3333333${index}-3333-4333-8333-333333333333`, assetType: 'poster_image',
    fileName: 'poster.png', mimeType: 'image/png', fileSizeBytes: PNG.length,
    sourceBucket: 'private', sourcePath: `drafts/target/${index}/poster.png`,
    publicBucket: 'assets', publicPath: `published/target/${index}/poster.png`,
    publicUrl: `https://example.com/published/target/${index}/poster.png`, altTextPublic: 'Poster',
    preExisting: false, sourceSha256: sha256(PNG), ...overrides,
  };
}

function createStorage(initial: Record<string, Buffer> = {}) {
  const objects = new Map(Object.entries(initial).map(([key, value]) => [key, Buffer.from(value)]));
  const uploadNewObject = vi.fn(async (bucket: string, path: string, content: Buffer) => {
    const key = `${bucket}/${path}`;
    if (objects.has(key)) return false;
    objects.set(key, Buffer.from(content));
    return true;
  });
  const storage: BoundPublicMediaStorage & { objects: Map<string, Buffer>; uploadNewObject: typeof uploadNewObject } = {
    objects,
    downloadObject: async (bucket: string, path: string) => objects.get(`${bucket}/${path}`) ?? null,
    uploadNewObject,
  };
  return storage;
}

describe('bound public media validation before write intent', () => {
  it('rejects a private source whose bytes changed after binding, touching nothing public', async () => {
    const storage = createStorage({ 'private/drafts/target/1/poster.png': OTHER_PNG });
    await expect(validateBoundPublicMedia(storage, [binding(1)])).rejects.toThrow('PRIVATE_MEDIA_CHANGED');
    expect(storage.uploadNewObject).not.toHaveBeenCalled();
    expect([...storage.objects.keys()]).toEqual(['private/drafts/target/1/poster.png']);
  });

  it('rejects a public destination already holding different bytes', async () => {
    const storage = createStorage({
      'private/drafts/target/1/poster.png': PNG,
      'assets/published/target/1/poster.png': OTHER_PNG,
    });
    await expect(validateBoundPublicMedia(storage, [binding(1)])).rejects.toThrow('MEDIA_STORAGE_CONFLICT');
    expect(storage.uploadNewObject).not.toHaveBeenCalled();
  });

  it('accepts a byte-identical object that genuinely predates the operation', async () => {
    const storage = createStorage({
      'private/drafts/target/1/poster.png': PNG,
      'assets/published/target/1/poster.png': PNG,
    });
    await expect(validateBoundPublicMedia(storage, [binding(1, { preExisting: true })])).resolves.toBeUndefined();
  });
});

describe('bound public media promotion after write intent', () => {
  it('converges forward from a partial promotion without deleting what it already created', async () => {
    const storage = createStorage({
      'private/drafts/target/1/poster.png': PNG,
      'private/drafts/target/2/poster.png': PNG,
      'assets/published/target/0/poster.png': OTHER_PNG,
    });
    const manifest = [binding(1), binding(2, { sourceSha256: sha256(OTHER_PNG) })];

    await expect(promoteBoundPublicMedia(storage, manifest)).rejects.toThrow('PRIVATE_MEDIA_CHANGED');
    expect(storage.objects.get('assets/published/target/1/poster.png')).toEqual(PNG);
    expect(storage.objects.get('assets/published/target/0/poster.png')).toEqual(OTHER_PNG);

    // The bound manifest is durable, so a later recovery owner replays it to completion.
    manifest[1] = binding(2);
    await expect(promoteBoundPublicMedia(storage, manifest)).resolves.toBeUndefined();
    expect(storage.objects.get('assets/published/target/2/poster.png')).toEqual(PNG);
  });

  it('is idempotent across repeated recovery attempts', async () => {
    const storage = createStorage({ 'private/drafts/target/1/poster.png': PNG });
    await promoteBoundPublicMedia(storage, [binding(1)]);
    await promoteBoundPublicMedia(storage, [binding(1)]);
    expect(storage.objects.get('assets/published/target/1/poster.png')).toEqual(PNG);
    expect(storage.objects.size).toBe(2);
  });

  it('fails when the promoted object cannot be read back byte-for-byte', async () => {
    const storage = createStorage({ 'private/drafts/target/1/poster.png': PNG });
    storage.downloadObject = async (bucket: string) =>
      (bucket === 'private' ? PNG : null);
    await expect(promoteBoundPublicMedia(storage, [binding(1)]))
      .rejects.toThrow('PUBLIC_MEDIA_VERIFICATION_FAILED');
  });
});
