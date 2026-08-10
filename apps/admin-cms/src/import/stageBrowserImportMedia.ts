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
  content: Buffer;
}

function buildStoragePath(projectPublicId: string, assetType: string, fileName: string): string {
  return `drafts/${projectPublicId}/${assetType}/${fileName}`;
}

/**
 * Uploads the validated media files for an already metadata-staged browser import batch into
 * private draft storage at deterministic, server-derived paths, then atomically registers the
 * corresponding media_assets rows and completes the batch via a hardened RPC.
 *
 * Storage and Postgres are not one distributed transaction: uploads happen first (idempotent-
 * safe, since paths are deterministic and existing objects are verified rather than overwritten),
 * and only objects created by THIS attempt are cleaned up if the database finalization fails.
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
    })),
  });

  // 2. Upload phase: deterministic, server-derived paths; never blindly overwrite.
  const newlyUploadedPaths: string[] = [];

  const cleanupNewlyUploaded = async (): Promise<void> => {
    if (newlyUploadedPaths.length === 0) return;
    try {
      await supabase.storage.from(bucket).remove(newlyUploadedPaths);
    } catch (cleanupErr: unknown) {
      const msg = cleanupErr instanceof Error ? cleanupErr.message : 'unknown cleanup error';
      process.stdout.write(`[Browser Import Media Stage] cleanup failure (objects remain recoverable by retry): ${msg}\n`);
    }
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
      await cleanupNewlyUploaded();
      return {
        success: false,
        code: 'STORAGE_UPLOAD_FAILED',
        error: 'The media file could not be uploaded to private storage.',
      };
    }

    // Object already exists at this deterministic path (from a prior attempt). Verify it is
    // genuinely the same content before treating this as an idempotent no-op; never overwrite.
    const dirPath = storagePath.slice(0, storagePath.lastIndexOf('/'));
    const { data: listing, error: listError } = await supabase.storage
      .from(bucket)
      .list(dirPath, { limit: 100, search: file.fileName });

    const existingEntry = listing?.find((entry) => entry.name === file.fileName);
    const existingSize =
      existingEntry && existingEntry.metadata && typeof existingEntry.metadata === 'object'
        ? (existingEntry.metadata as Record<string, unknown>).size
        : undefined;

    if (listError || !existingEntry || existingSize !== file.content.length) {
      await cleanupNewlyUploaded();
      return {
        success: false,
        code: 'STORAGE_CONFLICT',
        error: 'An existing private storage object could not be safely reconciled with this upload.',
      };
    }
    // Sizes match: treat as already uploaded by a previous attempt; do not touch it.
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
    await cleanupNewlyUploaded();
    return { success: false, code: 'PERSISTENCE_FAILED', error: 'The media staging operation could not be saved.' };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    await cleanupNewlyUploaded();
    return {
      success: false,
      code: 'PERSISTENCE_FAILED',
      error: 'The media staging operation returned an invalid response.',
    };
  }

  const res = data as Record<string, unknown>;
  if (typeof res.resultCode !== 'string') {
    await cleanupNewlyUploaded();
    return {
      success: false,
      code: 'PERSISTENCE_FAILED',
      error: 'The media staging operation returned an incomplete result code.',
    };
  }

  if (res.resultCode !== 'SUCCESS') {
    await cleanupNewlyUploaded();
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
    await cleanupNewlyUploaded();
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
