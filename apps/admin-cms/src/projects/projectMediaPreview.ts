import { SupabaseClient } from '@supabase/supabase-js';

import { getStagingBuckets } from '../lib/supabase/buckets';
import { createSignedDraftMediaUrl } from '../storage/mediaStorage';
import { isValidMediaUrl } from '../components/admin-media/mediaPreviewUtils';
import type { ProjectMediaPreviewItem } from '../components/admin-media/mediaPreviewTypes';

export interface ProjectMediaAssetPreviewRow {
  id: string;
  asset_type: string;
  file_name: string;
  storage_bucket: string;
  storage_path: string;
  public_url: string | null;
  mime_type: string | null;
  file_size_bytes: number | string | null;
  is_public_approved: boolean | null;
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

function fallbackAltText(row: ProjectMediaAssetPreviewRow, projectTitle: string, accessibilityText?: string): string | undefined {
  if (row.asset_type === 'poster_image' && accessibilityText?.trim()) return accessibilityText.trim();
  if (row.mime_type?.toLowerCase().startsWith('image/')) {
    return `${row.file_name || 'Image'} preview for ${projectTitle || 'this project'}`;
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
    altText: fallbackAltText(row, params.projectTitle, params.accessibilityText),
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
  projectTitle: string;
  accessibilityText?: string;
  privateBucket?: string;
  signDraftMediaUrl?: typeof createSignedDraftMediaUrl;
}): Promise<ProjectMediaPreviewItem[]> {
  const privateBucket = params.privateBucket ?? getStagingBuckets().DRAFT_PRIVATE;
  const { data, error } = await params.supabase
    .from('media_assets')
    .select('id,asset_type,file_name,storage_bucket,storage_path,public_url,mime_type,file_size_bytes,is_public_approved')
    .eq('project_id', params.projectId)
    .order('asset_type', { ascending: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (error) throw new ProjectMediaPreviewReadError();

  return Promise.all((data ?? []).map((row) => toProjectMediaPreviewItem(row as ProjectMediaAssetPreviewRow, {
    projectTitle: params.projectTitle,
    accessibilityText: params.accessibilityText,
    privateBucket,
    signDraftMediaUrl: params.signDraftMediaUrl,
  })));
}
