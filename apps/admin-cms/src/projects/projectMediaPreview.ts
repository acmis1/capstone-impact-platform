import { SupabaseClient } from '@supabase/supabase-js';

import { getStagingBuckets } from '../lib/supabase/buckets';
import { createSignedDraftMediaUrl } from '../storage/mediaStorage';
import { isValidMediaUrl } from '../components/admin-media/mediaPreviewUtils';
import type { ProjectMediaPreviewItem } from '../components/admin-media/mediaPreviewTypes';
import type {
  ApprovalMediaAssetEvidence,
  ApprovalMediaInput,
  ApprovalSnapshotMediaInput,
} from '../validation/projectValidation';
import { validateMediaAsset } from '../storage/mediaValidationCore';

export interface ProjectMediaAssetPreviewRow {
  id: string;
  asset_type: string;
  file_name: string;
  storage_bucket: string;
  storage_path: string;
  public_url: string | null;
  public_storage_bucket: string | null;
  public_storage_path: string | null;
  mime_type: string | null;
  file_size_bytes: number | string | null;
  is_public_approved: boolean | null;
  alt_text_public: string | null;
}

export interface ProjectMediaReviewData {
  items: ProjectMediaPreviewItem[];
  approvalMedia: ApprovalMediaInput;
}

export class ProjectMediaPreviewReadError extends Error {
  constructor() {
    super('Media preview records could not be loaded.');
  }
}

function fileSizeBytes(value: ProjectMediaAssetPreviewRow['file_size_bytes']): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function isValidPrivateApprovalAsset(
  row: ProjectMediaAssetPreviewRow,
  params: { assetType: string; projectPublicId: string; privateBucket: string },
): boolean {
  const size = fileSizeBytes(row.file_size_bytes);
  const fileName = row.file_name?.trim();
  const mimeType = row.mime_type?.trim();
  const storagePath = row.storage_path?.trim();
  const expectedPrefix = `drafts/${params.projectPublicId}/${params.assetType}/`;

  if (
    row.asset_type !== params.assetType ||
    row.storage_bucket !== params.privateBucket ||
    row.is_public_approved !== false ||
    row.public_url !== null ||
    row.public_storage_bucket !== null ||
    row.public_storage_path !== null ||
    !fileName ||
    !mimeType ||
    size === undefined ||
    !storagePath ||
    !storagePath.startsWith(expectedPrefix) ||
    !storagePath.endsWith(fileName) ||
    storagePath.includes('..') ||
    storagePath.includes('\\')
  ) {
    return false;
  }

  const validation = validateMediaAsset({ fileName, fileSizeBytes: size, mimeType });
  if (!validation.valid) return false;

  return params.assetType === 'poster_pdf'
    ? mimeType === 'application/pdf'
    : mimeType.startsWith('image/');
}

function mediaEvidence(
  rows: ProjectMediaAssetPreviewRow[],
  params: { assetType: string; projectPublicId: string; privateBucket: string },
): ApprovalMediaAssetEvidence {
  const matching = rows.filter((row) => row.asset_type === params.assetType);
  return {
    rowCount: matching.length,
    validPrivateCount: matching.filter((row) => isValidPrivateApprovalAsset(row, params)).length,
  };
}

export function deriveApprovalMediaInput(
  rows: ProjectMediaAssetPreviewRow[],
  params: { projectPublicId: string; privateBucket: string },
): ApprovalMediaInput {
  const posterImage = mediaEvidence(rows, { ...params, assetType: 'poster_image' });
  const posterPdf = mediaEvidence(rows, { ...params, assetType: 'poster_pdf' });
  const snapshots = rows.filter((row) => row.asset_type === 'snapshot_image');
  const snapshotEvidence = mediaEvidence(rows, { ...params, assetType: 'snapshot_image' });
  const snapshotMedia: ApprovalSnapshotMediaInput | null = snapshots.length === 0
    ? null
    : {
        ...snapshotEvidence,
        altText: snapshots.length === 1 ? snapshots[0].alt_text_public : null,
      };

  return { posterImage, posterPdf, snapshotMedia };
}

/**
 * The authoritative text alternative for one media asset, or undefined when none is stored.
 *
 * A snapshot image uses its own stored `alt_text_public`; the poster image uses the project-level
 * accessibility text. There is deliberately no filename-derived fallback any more: a string like
 * "snapshot-1.png preview for Project X" describes the file, not the image, and rendering it as
 * saved alt text told staff an image was described when it was not. When nothing is stored the
 * value is undefined and the UI states plainly that the alt text is missing.
 */
function authoritativeAltText(
  row: ProjectMediaAssetPreviewRow,
  accessibilityText?: string,
): string | undefined {
  if (row.asset_type === 'poster_image') {
    return accessibilityText?.trim() || undefined;
  }
  if (row.asset_type === 'snapshot_image') {
    return row.alt_text_public?.trim() || undefined;
  }
  return undefined;
}

export async function toProjectMediaPreviewItem(
  row: ProjectMediaAssetPreviewRow,
  params: {
    projectTitle: string;
    accessibilityText?: string;
    privateBucket: string;
    signDraftMediaUrl?: typeof createSignedDraftMediaUrl;
  },
): Promise<ProjectMediaPreviewItem> {
  const item: ProjectMediaPreviewItem = {
    id: row.id,
    assetType: row.asset_type,
    fileName: row.file_name || 'Unnamed media file',
    mimeType: row.mime_type || 'application/octet-stream',
    fileSize: fileSizeBytes(row.file_size_bytes),
    altText: authoritativeAltText(row, params.accessibilityText),
    previewSource: 'unavailable',
  };

  if (row.is_public_approved === true) {
    if (isValidMediaUrl(row.public_url ?? undefined)) {
      return { ...item, url: row.public_url ?? undefined, previewSource: 'public' };
    }
    return item;
  }

  if (row.storage_bucket !== params.privateBucket) return item;

  try {
    const signDraftMediaUrl = params.signDraftMediaUrl ?? createSignedDraftMediaUrl;
    const previewUrl = await signDraftMediaUrl({
      storageBucket: row.storage_bucket,
      storagePath: row.storage_path,
    });
    if (isValidMediaUrl(previewUrl ?? undefined)) {
      return { ...item, url: previewUrl ?? undefined, previewSource: 'private-signed' };
    }
  } catch {
    // Signing is auxiliary. Retain authoritative metadata without exposing the private path.
  }

  return item;
}

export async function loadProjectMediaPreviewItems(params: {
  supabase: SupabaseClient;
  projectId: string;
  projectPublicId: string;
  projectTitle: string;
  accessibilityText?: string;
  privateBucket?: string;
  signDraftMediaUrl?: typeof createSignedDraftMediaUrl;
}): Promise<ProjectMediaPreviewItem[]> {
  const result = await loadProjectMediaReviewData(params);
  return result.items;
}

export async function loadProjectMediaReviewData(params: {
  supabase: SupabaseClient;
  projectId: string;
  projectPublicId: string;
  projectTitle: string;
  accessibilityText?: string;
  privateBucket?: string;
  signDraftMediaUrl?: typeof createSignedDraftMediaUrl;
}): Promise<ProjectMediaReviewData> {
  const privateBucket = params.privateBucket ?? getStagingBuckets().DRAFT_PRIVATE;
  const { data, error } = await params.supabase
    .from('media_assets')
    .select('id,asset_type,file_name,storage_bucket,storage_path,public_url,public_storage_bucket,public_storage_path,mime_type,file_size_bytes,is_public_approved,alt_text_public')
    .eq('project_id', params.projectId)
    .order('asset_type', { ascending: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (error) throw new ProjectMediaPreviewReadError();

  const rows = (data ?? []) as ProjectMediaAssetPreviewRow[];
  const items = await Promise.all(rows.map((row) => toProjectMediaPreviewItem(row, {
    projectTitle: params.projectTitle,
    accessibilityText: params.accessibilityText,
    privateBucket,
    signDraftMediaUrl: params.signDraftMediaUrl,
  })));

  return {
    items,
    approvalMedia: deriveApprovalMediaInput(rows, {
      projectPublicId: params.projectPublicId,
      privateBucket,
    }),
  };
}
