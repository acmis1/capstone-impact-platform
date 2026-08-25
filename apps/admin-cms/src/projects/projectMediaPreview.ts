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
import {
  describeAccessibleContentProblem,
  getSnapshotAltTextProblem,
} from '../domain/accessibleContent';

export interface ProjectMediaAssetPreviewRow {
  id: string;
  asset_type: string;
  gallery_position: number | null;
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

function mediaDisplayRank(assetType: string): number {
  switch (assetType) {
    case 'poster_image':
      return 0;
    case 'poster_pdf':
      return 1;
    case 'snapshot_image':
      return 2;
    default:
      return 3;
  }
}

function validGalleryPosition(position: number | null): number | undefined {
  return typeof position === 'number' && Number.isInteger(position) && position > 0
    ? position
    : undefined;
}

/** Authoritative Admin media display order, including the numeric snapshot gallery sequence. */
export function compareProjectMediaDisplayOrder(
  left: Pick<ProjectMediaAssetPreviewRow, 'id' | 'asset_type' | 'gallery_position'>,
  right: Pick<ProjectMediaAssetPreviewRow, 'id' | 'asset_type' | 'gallery_position'>,
): number {
  const rankDifference = mediaDisplayRank(left.asset_type) - mediaDisplayRank(right.asset_type);
  if (rankDifference !== 0) return rankDifference;

  if (left.asset_type === 'snapshot_image' && right.asset_type === 'snapshot_image') {
    const leftPosition = validGalleryPosition(left.gallery_position);
    const rightPosition = validGalleryPosition(right.gallery_position);
    if (leftPosition !== undefined || rightPosition !== undefined) {
      if (leftPosition === undefined) return 1;
      if (rightPosition === undefined) return -1;
      if (leftPosition !== rightPosition) return leftPosition - rightPosition;
    }
  }

  if (left.asset_type !== right.asset_type) return left.asset_type.localeCompare(right.asset_type);
  return left.id.localeCompare(right.id);
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
  const snapshots = rows.filter(
    (row) => row.asset_type === 'snapshot_image',
  );

  const snapshotMedia: ApprovalSnapshotMediaInput[] = snapshots
    .map((row) => ({
      galleryPosition: row.gallery_position,
      validPrivate: isValidPrivateApprovalAsset(row, {
        ...params,
        assetType: 'snapshot_image',
      }),
      altText: row.alt_text_public,
    }))
    .sort(
      (a, b) =>
        (a.galleryPosition ?? Number.MAX_SAFE_INTEGER) -
        (b.galleryPosition ?? Number.MAX_SAFE_INTEGER),
    );

  return { posterImage, posterPdf, snapshotMedia };
}

/**
 * Read-only submission preflight for Tan's final snapshot-gallery gate. The
 * submission RPC remains authoritative; this deliberately shares the same
 * staged-media identity checks as the approval preview instead of inventing a
 * second browser-only interpretation of a gallery row.
 */
export function validateSubmissionSnapshotGallery(
  rows: ProjectMediaAssetPreviewRow[],
  params: { projectPublicId: string; privateBucket: string },
): string[] {
  const snapshots = rows.filter((row) => row.asset_type === 'snapshot_image');
  if (snapshots.length === 0) return [];

  const positions = new Set<number>();
  const structurallyInvalid = snapshots.length > 10 || snapshots.some((snapshot) => {
    const position = snapshot.gallery_position;
    if (
      position === null ||
      !Number.isInteger(position) ||
      position < 1 ||
      position > 10 ||
      positions.has(position) ||
      !isValidPrivateApprovalAsset(snapshot, { ...params, assetType: 'snapshot_image' })
    ) {
      return true;
    }
    positions.add(position);
    return false;
  });

  const reasons: string[] = [];
  if (structurallyInvalid) reasons.push('Snapshot gallery staged media is invalid.');

  for (const snapshot of snapshots) {
    const problem = getSnapshotAltTextProblem(snapshot.alt_text_public, { snapshotPresent: true });
    if (!problem) continue;
    const message = describeAccessibleContentProblem(problem, 'snapshotAltText');
    if (!reasons.includes(message)) reasons.push(message);
  }
  return reasons;
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
    galleryPosition: row.gallery_position,
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
    .select('id,asset_type,gallery_position,file_name,storage_bucket,storage_path,public_url,public_storage_bucket,public_storage_path,mime_type,file_size_bytes,is_public_approved,alt_text_public')
    .eq('project_id', params.projectId)
    .order('id', { ascending: true });

  if (error) throw new ProjectMediaPreviewReadError();

  const rows = [...((data ?? []) as ProjectMediaAssetPreviewRow[])].sort(compareProjectMediaDisplayOrder);
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
