import { createHash } from 'crypto';
import { validateMediaAssetBytes } from '../storage/mediaValidationCore';
import type { PublicationMediaBinding } from './publicationArtifact';

/**
 * Public media promotion, split across the durable forward-commit boundary.
 *
 * Before the boundary the operation may still fail safely, so nothing here may create a publicly
 * readable object; only read-only validation runs. After the boundary every external side effect is
 * already durably described by the immutable bound manifest, so promotion is idempotent, replayable
 * by any later recovery owner, and never deletes anything — including objects it created itself.
 * Reverse compensation is deliberately absent: a partially promoted operation converges forward.
 */

export interface BoundPublicMediaStorage {
  downloadObject(bucket: string, path: string): Promise<Buffer | null>;
  uploadNewObject(bucket: string, path: string, content: Buffer, contentType: string): Promise<boolean>;
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function readBoundSource(
  storage: BoundPublicMediaStorage,
  media: PublicationMediaBinding,
): Promise<Buffer> {
  const source = await storage.downloadObject(media.sourceBucket, media.sourcePath);
  if (!source) throw new Error('PRIVATE_MEDIA_UNAVAILABLE');
  if (sha256(source) !== media.sourceSha256) throw new Error('PRIVATE_MEDIA_CHANGED');
  const valid = validateMediaAssetBytes({
    fileName: media.fileName, content: source, expectedMimeType: media.mimeType,
    expectedFileSizeBytes: media.fileSizeBytes,
  });
  if (!valid.valid) throw new Error('PRIVATE_MEDIA_INVALID');
  return source;
}

/**
 * Read-only re-validation of everything the operation is about to expose. Runs while the operation
 * can still fail cleanly, so a source that changed after binding, or a conflicting public
 * destination, is rejected with zero task-created public objects in existence.
 */
export async function validateBoundPublicMedia(
  storage: BoundPublicMediaStorage,
  manifest: PublicationMediaBinding[],
): Promise<void> {
  for (const media of manifest) {
    const source = await readBoundSource(storage, media);
    const existing = await storage.downloadObject(media.publicBucket, media.publicPath);
    if (existing && !existing.equals(source)) throw new Error('MEDIA_STORAGE_CONFLICT');
  }
}

/**
 * The only path that makes new media publicly readable. Callers must have crossed the durable
 * forward-commit boundary first.
 */
export async function promoteBoundPublicMedia(
  storage: BoundPublicMediaStorage,
  manifest: PublicationMediaBinding[],
): Promise<void> {
  for (const media of manifest) {
    const source = await readBoundSource(storage, media);
    await storage.uploadNewObject(media.publicBucket, media.publicPath, source, media.mimeType);
    const verified = await storage.downloadObject(media.publicBucket, media.publicPath);
    if (!verified || !verified.equals(source)) throw new Error('PUBLIC_MEDIA_VERIFICATION_FAILED');
  }
}
