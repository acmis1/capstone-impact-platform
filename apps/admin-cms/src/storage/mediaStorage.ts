import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { getStagingBuckets } from '../lib/supabase/buckets';
import { MediaAsset, MediaAssetType } from '../domain/mediaAsset';
import { validateMediaAsset } from './mediaValidation';

/** Short-lived signed URL TTL for participant preview media (5 minutes). */
export const PREVIEW_SIGNED_URL_TTL_SECONDS = 300;

/**
 * Generates a short-lived signed URL for a private draft media object, for participant preview
 * rendering only. Defense-in-depth: only ever signs objects that are still in the private draft
 * bucket — a snapshotted reference pointing anywhere else (e.g. if an asset were later promoted
 * to the public bucket, changing its bucket/path) is refused rather than silently resolved.
 * Returns null on any failure so callers can fail safe instead of substituting unrelated media.
 */
export async function createSignedDraftMediaUrl(params: {
  storageBucket: string;
  storagePath: string;
  ttlSeconds?: number;
}): Promise<string | null> {
  const { storageBucket, storagePath, ttlSeconds } = params;
  const buckets = getStagingBuckets();

  if (storageBucket !== buckets.DRAFT_PRIVATE) {
    return null;
  }

  let data: { signedUrl?: string } | null = null;
  let error: unknown = null;
  try {
    const supabase = createSupabaseAdminClientCore();
    ({ data, error } = await supabase.storage
      .from(storageBucket)
      .createSignedUrl(storagePath, ttlSeconds ?? PREVIEW_SIGNED_URL_TTL_SECONDS));
  } catch (err) {
    error = err;
  }

  if (error || !data?.signedUrl) {
    return null;
  }

  return data.signedUrl;
}

/**
 * Uploads a draft media asset to the private staging bucket and registers it in database.
 */
export async function uploadDraftMediaAsset(params: {
  projectPublicId: string;
  projectDbId?: string;
  assetType: MediaAssetType;
  fileName: string;
  content: Buffer;
  mimeType: string;
  /**
   * Authoritative gallery position for a `snapshot_image`, from 1 through 10.
   *
   * Required for snapshots and rejected for every other asset type, mirroring the
   * media_assets gallery-position constraint. Without it a snapshot would carry no
   * gallery identity.
   */
  galleryPosition?: number;
}): Promise<MediaAsset> {
  const { projectPublicId, projectDbId, assetType, fileName, content, mimeType, galleryPosition } = params;

  // 1. Local Validation
  const validation = validateMediaAsset({
    fileName,
    fileSizeBytes: content.length,
    mimeType
  });

  if (!validation.valid) {
    throw new Error(`Media Asset Validation Failed: ${validation.errors.join('; ')}`);
  }

  const isSnapshot = assetType === 'snapshot_image';

  if (isSnapshot) {
    if (
      typeof galleryPosition !== 'number'
      || !Number.isInteger(galleryPosition)
      || galleryPosition < 1
      || galleryPosition > 10
    ) {
      throw new Error('Media Asset Validation Failed: snapshot_image requires an integer galleryPosition from 1 through 10');
    }
  } else if (galleryPosition !== undefined) {
    throw new Error(`Media Asset Validation Failed: galleryPosition is not valid for asset type [${assetType}]`);
  }

  const supabase = createSupabaseAdminClientCore();
  const buckets = getStagingBuckets();
  const bucket = buckets.DRAFT_PRIVATE;

  // 2. Resolve database project UUID if not supplied
  let resolvedProjectDbId = projectDbId;
  if (!resolvedProjectDbId) {
    const { data: projectRow, error: findError } = await supabase
      .from('projects')
      .select('id')
      .eq('public_id', projectPublicId)
      .maybeSingle();

    if (findError || !projectRow) {
      throw new Error(`Failed to associate media asset. Staging project [${projectPublicId}] not found in database: ${findError?.message || 'Not Found'}`);
    }
    resolvedProjectDbId = projectRow.id;
  }

  // 3. Compose private storage path: drafts/{projectPublicId}/{assetType}/{timestamp}-{safeFileName}
  const timestamp = Date.now();
  const storagePath = `drafts/${projectPublicId}/${assetType}/${timestamp}-${fileName}`;

  console.log(`Uploading private draft asset [${fileName}] to bucket [${bucket}] at [${storagePath}]...`);

  // 4. Upload binary content to private bucket
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(storagePath, content, {
      contentType: mimeType,
      upsert: true
    });

  if (uploadError) {
    throw new Error(`Supabase Storage upload to private drafts failed: ${uploadError.message}`);
  }

  // 5. Insert row into media_assets table
  const { data: dbAsset, error: insertError } = await supabase
    .from('media_assets')
    .insert({
      project_id: resolvedProjectDbId,
      asset_type: assetType,
      gallery_position: isSnapshot ? galleryPosition : null,
      file_name: fileName,
      storage_bucket: bucket,
      storage_path: storagePath,
      public_url: null,
      mime_type: mimeType,
      file_size_bytes: content.length,
      is_public_approved: false
    })
    .select()
    .single();

  if (insertError || !dbAsset) {
    throw new Error(`Failed to record media asset row in database: ${insertError?.message || 'Insert returned null'}`);
  }

  return {
    id: dbAsset.id,
    projectId: dbAsset.project_id,
    projectPublicId,
    assetType: dbAsset.asset_type,
    fileName: dbAsset.file_name,
    storageBucket: dbAsset.storage_bucket,
    storagePath: dbAsset.storage_path,
    publicUrl: dbAsset.public_url || undefined,
    mimeType: dbAsset.mime_type || undefined,
    fileSizeBytes: dbAsset.file_size_bytes ? parseInt(dbAsset.file_size_bytes, 10) : undefined,
    isPublicApproved: dbAsset.is_public_approved,
    altTextPublic: dbAsset.alt_text_public ?? null,
    createdAt: dbAsset.created_at
  };
}

/**
 * Downloads a draft media asset from private bucket and uploads it to the public assets bucket.
 */
export async function promoteDraftMediaAssetToPublic(assetId: string): Promise<MediaAsset> {
  const supabase = createSupabaseAdminClientCore();
  const buckets = getStagingBuckets();
  
  // 1. Fetch current media asset details from DB
  const { data: dbAsset, error: fetchError } = await supabase
    .from('media_assets')
    .select('*, projects(public_id)')
    .eq('id', assetId)
    .single();

  if (fetchError || !dbAsset) {
    throw new Error(`Failed to find media asset [${assetId}] in database: ${fetchError?.message || 'Not Found'}`);
  }

  const projectPublicId = dbAsset.projects?.public_id;
  if (!projectPublicId) {
    throw new Error(`Corrupted media asset: associated project is missing public_id`);
  }

  const privateBucket = dbAsset.storage_bucket;
  const privatePath = dbAsset.storage_path;
  const publicBucket = buckets.PUBLIC_ASSETS;

  console.log(`Downloading private draft asset from [${privateBucket}/${privatePath}]...`);

  // 2. Download from private bucket
  const { data: fileBlob, error: downloadError } = await supabase.storage
    .from(privateBucket)
    .download(privatePath);

  if (downloadError || !fileBlob) {
    throw new Error(`Failed to download draft media file from private storage: ${downloadError?.message || 'Blob is null'}`);
  }

  // 3. Convert Blob to ArrayBuffer/Buffer
  const arrayBuffer = await fileBlob.arrayBuffer();
  const fileBuffer = Buffer.from(arrayBuffer);

  // 4. Compose public path: approved/{projectPublicId}/{assetType}/{fileName}
  const publicPath = `approved/${projectPublicId}/${dbAsset.asset_type}/${dbAsset.file_name}`;

  console.log(`Promoting approved asset to public bucket [${publicBucket}] at [${publicPath}]...`);

  // 5. Upload to public bucket
  const { error: uploadError } = await supabase.storage
    .from(publicBucket)
    .upload(publicPath, fileBuffer, {
      contentType: dbAsset.mime_type,
      upsert: true
    });

  if (uploadError) {
    throw new Error(`Failed to upload approved file to public storage: ${uploadError.message}`);
  }

  // 6. Resolve public showcase URL
  const { data: urlData } = supabase.storage
    .from(publicBucket)
    .getPublicUrl(publicPath);

  if (!urlData || !urlData.publicUrl) {
    throw new Error(`Failed to generate public URL for approved asset [${publicPath}]`);
  }

  console.log(`Asset successfully promoted. Resolved Public URL: ${urlData.publicUrl}`);

  // 7. Update database row with public storage details and approval state
  const { data: updatedAsset, error: updateError } = await supabase
    .from('media_assets')
    .update({
      public_url: urlData.publicUrl,
      public_storage_bucket: publicBucket,
      public_storage_path: publicPath,
      is_public_approved: true
    })
    .eq('id', assetId)
    .select()
    .single();

  if (updateError || !updatedAsset) {
    throw new Error(`Failed to update media asset database approval status: ${updateError?.message || 'Update returned null'}`);
  }

  return {
    id: updatedAsset.id,
    projectId: updatedAsset.project_id,
    projectPublicId,
    assetType: updatedAsset.asset_type,
    fileName: updatedAsset.file_name,
    storageBucket: updatedAsset.storage_bucket,
    storagePath: updatedAsset.storage_path,
    publicUrl: updatedAsset.public_url || undefined,
    mimeType: updatedAsset.mime_type || undefined,
    fileSizeBytes: updatedAsset.file_size_bytes ? parseInt(updatedAsset.file_size_bytes, 10) : undefined,
    isPublicApproved: updatedAsset.is_public_approved,
    altTextPublic: updatedAsset.alt_text_public ?? null,
    createdAt: updatedAsset.created_at
  };
}
