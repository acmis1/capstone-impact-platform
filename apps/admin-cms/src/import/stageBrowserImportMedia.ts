import { createHash } from 'crypto';
import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { getStagingBuckets } from '../lib/supabase/buckets';
import { AuthenticatedAdminContext } from '../auth/authTypes';
import {
  BrowserImportMediaStageErrorCode,
  BrowserImportMediaStageResponse,
  computeCanonicalMediaIntentHash,
} from './browserImportMediaStageContract';
import { BrowserImportMediaAssetType } from './browserImportMediaSelection';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MediaFileToStage {
  packagePath: string;
  projectPublicId: string;
  assetType: BrowserImportMediaAssetType;
  fileName: string;
  fileSizeBytes: number;
  canonicalMimeType: string;
  /**
   * Server-derived text alternative for a `snapshot_image`; null for all other asset types and for
   * a legacy snapshot with no supplied alt text. The caller must take this from the reparsed
   * package manifest — it is never accepted from the browser as an independent value.
   */
  snapshotAltText: string | null;
  content: Buffer;
}

function buildStoragePath(projectPublicId: string, assetType: string, fileName: string): string {
  return `drafts/${projectPublicId}/${assetType}/${fileName}`;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Downloads an existing object at `storagePath` and proves it is byte-for-byte identical to
 * `expectedContent` (size + SHA-256 of the actual downloaded bytes, never just size or metadata).
 * Any failure to read the object back is treated as unverifiable, not as a pass — matching size
 * alone is never accepted as proof of identity, since a same-size different object must not be
 * silently reused.
 */
async function existingObjectMatchesContent(
  supabase: ReturnType<typeof createSupabaseAdminClientCore>,
  bucket: string,
  storagePath: string,
  expectedContent: Buffer
): Promise<boolean> {
  const { data: existingBlob, error: downloadError } = await supabase.storage.from(bucket).download(storagePath);
  if (downloadError || !existingBlob) {
    return false;
  }

  const existingBytes = Buffer.from(await existingBlob.arrayBuffer());
  if (existingBytes.length !== expectedContent.length) {
    return false;
  }

  return sha256Hex(existingBytes) === sha256Hex(expectedContent);
}

/**
 * Uploads the validated media files for an already metadata-staged browser import batch into
 * private draft storage at deterministic, server-derived paths, then atomically registers the
 * corresponding media_assets rows and completes the batch via a hardened RPC.
 *
 * Storage and Postgres are not one distributed transaction: uploads happen first, before the
 * database advisory lock inside the finalization RPC even exists. Because storage paths are
 * deterministic (derived only from projectPublicId/assetType/fileName), two independent
 * first-time attempts for the same batch can both observe and rely on the same uploaded object -
 * there is no ownership record proving a given attempt is the only one that needs it. So a
 * failed attempt never deletes objects it uploaded: an object left behind by a failed attempt is
 * safe by construction (deterministic path, content-verified before ever being trusted), and an
 * exact retry re-verifies its bytes rather than assuming a size match is proof of identity.
 */
export async function stageBrowserImportMedia(params: {
  authContext: AuthenticatedAdminContext;
  batchId: string;
  metadataIntentHash: string;
  files: MediaFileToStage[];
}): Promise<BrowserImportMediaStageResponse> {
  const { authContext, batchId, metadataIntentHash, files } = params;

  if (!UUID_REGEX.test(batchId)) {
    return { success: false, code: 'INVALID_BATCH_ID', error: 'The import batch identifier is invalid.' };
  }

  if (files.length === 0 || files.length > 75) {
    return {
      success: false,
      code: 'INVALID_SELECTION',
      error: 'No expected media files were resolved for the selected packages.',
    };
  }

  const supabase = createSupabaseAdminClientCore();
  const buckets = getStagingBuckets();
  const bucket = buckets.DRAFT_PRIVATE;

  // 1. Resolve authoritative batch/commit binding before touching storage. This is what
  //    prevents a caller from attaching unrelated files to an arbitrary batch: the resubmitted
  //    manifest/intent must reproduce the exact hash recorded when metadata staging occurred.
  const { data: commitRow, error: commitError } = await supabase
    .from('browser_import_commits')
    .select('batch_id, intent_hash')
    .eq('batch_id', batchId)
    .maybeSingle();

  if (commitError) {
    process.stdout.write(`[Browser Import Media Stage] commit lookup error ${commitError.code || 'UNKNOWN'}\n`);
    return {
      success: false,
      code: 'UNEXPECTED_INTERNAL_ERROR',
      error: 'The media staging operation could not be completed. Please try again.',
    };
  }

  if (!commitRow || commitRow.intent_hash !== metadataIntentHash) {
    return {
      success: false,
      code: 'BATCH_INTENT_MISMATCH',
      error: 'The import batch could not be verified for this request.',
    };
  }

  const { data: batchRow, error: batchError } = await supabase
    .from('import_batches')
    .select('id, status')
    .eq('id', batchId)
    .maybeSingle();

  if (batchError) {
    process.stdout.write(`[Browser Import Media Stage] batch lookup error ${batchError.code || 'UNKNOWN'}\n`);
    return {
      success: false,
      code: 'UNEXPECTED_INTERNAL_ERROR',
      error: 'The media staging operation could not be completed. Please try again.',
    };
  }

  if (!batchRow) {
    return { success: false, code: 'BATCH_NOT_FOUND', error: 'The import batch could not be found.' };
  }

  if (batchRow.status !== 'metadata_staged' && batchRow.status !== 'completed') {
    return {
      success: false,
      code: 'INVALID_BATCH_STATE',
      error: 'The import batch is not in a state that allows media staging.',
    };
  }

  const mediaIntentHash = computeCanonicalMediaIntentHash({
    batchId,
    metadataIntentHash,
    files: files.map((f) => ({
      packagePath: f.packagePath,
      projectPublicId: f.projectPublicId,
      assetType: f.assetType,
      fileName: f.fileName,
      fileSizeBytes: f.fileSizeBytes,
      snapshotAltText: f.snapshotAltText,
    })),
  });

  // 2. Upload phase: deterministic, server-derived paths; never blindly overwrite.
  //    Objects created by this attempt are NEVER deleted on a later failure in this function -
  //    see the deletion-safety note in the docstring above. `newlyUploadedPaths` is retained
  //    only for diagnostic logging, not for cleanup.
  const newlyUploadedPaths: string[] = [];

  const logAbandonedUploads = (): void => {
    if (newlyUploadedPaths.length === 0) return;
    process.stdout.write(
      `[Browser Import Media Stage] leaving ${newlyUploadedPaths.length} newly uploaded object(s) in private draft storage after a failed attempt (safe: deterministic path, content-verified before reuse): ${newlyUploadedPaths.join(', ')}\n`
    );
  };

  for (const file of files) {
    const storagePath = buildStoragePath(file.projectPublicId, file.assetType, file.fileName);

    const { error: uploadError } = await supabase.storage.from(bucket).upload(storagePath, file.content, {
      contentType: file.canonicalMimeType,
      upsert: false,
    });

    if (!uploadError) {
      newlyUploadedPaths.push(storagePath);
      continue;
    }

    const isDuplicate = /already exists|duplicate/i.test(uploadError.message || '');
    if (!isDuplicate) {
      process.stdout.write(`[Browser Import Media Stage] storage upload error: ${uploadError.message}\n`);
      logAbandonedUploads();
      return {
        success: false,
        code: 'STORAGE_UPLOAD_FAILED',
        error: 'The media file could not be uploaded to private storage.',
      };
    }

    // Object already exists at this deterministic path (from a prior attempt, possibly a
    // concurrent one). Matching size is not proof of identity: download it and verify it is
    // genuinely byte-for-byte identical to the freshly server-validated incoming file before
    // treating this as an idempotent no-op. Never overwrite it either way.
    const matchesContent = await existingObjectMatchesContent(supabase, bucket, storagePath, file.content);

    if (!matchesContent) {
      logAbandonedUploads();
      return {
        success: false,
        code: 'STORAGE_CONFLICT',
        error: 'An existing private storage object could not be safely reconciled with this upload.',
      };
    }
    // Bytes verified identical: treat as already uploaded by a previous attempt; do not touch it.
  }

  // 3. Atomic database finalization via hardened RPC.
  const assetsPayload = files.map((f) => ({
    projectPublicId: f.projectPublicId,
    packagePath: f.packagePath,
    assetType: f.assetType,
    fileName: f.fileName,
    storageBucket: bucket,
    storagePath: buildStoragePath(f.projectPublicId, f.assetType, f.fileName),
    mimeType: f.canonicalMimeType,
    fileSizeBytes: f.fileSizeBytes,
    snapshotAltText: f.snapshotAltText,
  }));

  const { data, error } = await supabase.rpc('finalize_browser_import_media_stage', {
    p_batch_id: batchId,
    p_media_intent_hash: mediaIntentHash,
    p_metadata_intent_hash: metadataIntentHash,
    p_completed_by_id: authContext.adminUserId,
    p_assets: assetsPayload,
  });

  if (error) {
    process.stdout.write(`[Browser Import Media Stage RPC Error] ${error.code || 'UNKNOWN'}\n`);
    logAbandonedUploads();
    return { success: false, code: 'PERSISTENCE_FAILED', error: 'The media staging operation could not be saved.' };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    logAbandonedUploads();
    return {
      success: false,
      code: 'PERSISTENCE_FAILED',
      error: 'The media staging operation returned an invalid response.',
    };
  }

  const res = data as Record<string, unknown>;
  if (typeof res.resultCode !== 'string') {
    logAbandonedUploads();
    return {
      success: false,
      code: 'PERSISTENCE_FAILED',
      error: 'The media staging operation returned an incomplete result code.',
    };
  }

  if (res.resultCode !== 'SUCCESS') {
    logAbandonedUploads();
    const codeStr = res.resultCode;
    const mapCode = (c: string): BrowserImportMediaStageErrorCode => {
      if (c === 'BATCH_NOT_FOUND') return 'BATCH_NOT_FOUND';
      if (c === 'INTENT_BINDING_MISMATCH') return 'BATCH_INTENT_MISMATCH';
      if (c === 'INVALID_BATCH_STATE') return 'INVALID_BATCH_STATE';
      if (c === 'INTENT_MISMATCH') return 'BATCH_ALREADY_COMPLETED_MISMATCH';
      if (c === 'INVALID_INTENT' || c === 'INVALID_SELECTION') return 'INVALID_SELECTION';
      return 'PERSISTENCE_FAILED';
    };
    return {
      success: false,
      code: mapCode(codeStr),
      error: 'The media staging operation could not be completed.',
    };
  }

  if (
    (res.result !== 'completed' && res.result !== 'already_completed') ||
    typeof res.batchId !== 'string' ||
    !UUID_REGEX.test(res.batchId) ||
    typeof res.mediaAssetCount !== 'number' ||
    !Number.isInteger(res.mediaAssetCount) ||
    res.mediaAssetCount < 0 ||
    res.batchStatus !== 'completed'
  ) {
    logAbandonedUploads();
    return {
      success: false,
      code: 'PERSISTENCE_FAILED',
      error: 'The media staging operation returned an invalid RPC response payload.',
    };
  }

  return {
    success: true,
    result: res.result,
    batchId: res.batchId,
    mediaAssetCount: res.mediaAssetCount,
    batchStatus: 'completed',
  };
}
