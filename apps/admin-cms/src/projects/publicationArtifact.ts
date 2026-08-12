import { Project } from '../domain/project';
import { compilePublicationCandidateFeed } from '../feed/compilePublicFeed';
import { serializePublicFeedArtifact } from '../feed/serializePublicFeedArtifact';
import { validatePublicFeed } from '../feed/validatePublicFeed';
import { validateMediaAsset } from '../storage/mediaValidation';

export type PublicationMediaAssetType = 'poster_image' | 'poster_pdf' | 'snapshot_image';

export interface PublicationMediaSource {
  id: string;
  projectId: string;
  assetType: string;
  fileName: string;
  storageBucket: string;
  storagePath: string;
  publicUrl: string | null;
  publicStorageBucket: string | null;
  publicStoragePath: string | null;
  mimeType: string;
  fileSizeBytes: number;
  isPublicApproved: boolean;
}

export interface PublicationMediaPromotion {
  mediaAssetId: string;
  assetType: PublicationMediaAssetType;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  sourceBucket: string;
  sourcePath: string;
  publicBucket: string;
  publicPath: string;
  publicUrl: string;
}

export interface PublicationArtifactPlan {
  feed: ReturnType<typeof compilePublicationCandidateFeed>;
  content: string;
  feedHash: string;
  recordCount: number;
  mediaPromotions: PublicationMediaPromotion[];
}

const PUBLIC_ID = /^[A-Za-z0-9_-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPPORTED_TYPES = new Set<PublicationMediaAssetType>(['poster_image', 'poster_pdf', 'snapshot_image']);

function assertPublicUrl(value: string, privateBucket: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Publication media URL is invalid.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || value.includes(privateBucket) || value.includes('/drafts/')) {
    throw new Error('Publication media URL is not public-safe.');
  }
}

export function buildDeterministicPublicMediaPath(
  publicId: string,
  assetType: PublicationMediaAssetType,
  fileName: string,
): string {
  if (!PUBLIC_ID.test(publicId) || !SUPPORTED_TYPES.has(assetType)) {
    throw new Error('Publication media destination is invalid.');
  }
  const validation = validateMediaAsset({ fileName, fileSizeBytes: 1, mimeType: assetType === 'poster_pdf' ? 'application/pdf' : 'image/png' });
  if (!validation.valid || !/^[A-Za-z0-9_.-]+$/.test(fileName)) {
    throw new Error('Publication media filename is unsafe.');
  }
  return `published/${publicId}/${assetType}/${fileName}`;
}

export function planPublicationArtifact(params: {
  projects: Project[];
  targetPublicId: string;
  mediaAssets: PublicationMediaSource[];
  privateBucket: string;
  publicBucket: string;
  getPublicUrl(bucket: string, path: string): string;
}): PublicationArtifactPlan {
  const { projects, targetPublicId, mediaAssets, privateBucket, publicBucket, getPublicUrl } = params;
  const targets = projects.filter((project) => project.publicId === targetPublicId);
  if (targets.length !== 1 || targets[0].status !== 'approved') {
    throw new Error('Publication candidate target is unavailable.');
  }

  const target = targets[0];
  const mediaPromotions: PublicationMediaPromotion[] = [];
  const seenTypes = new Set<string>();

  for (const asset of mediaAssets) {
    if (!UUID.test(asset.id) || seenTypes.has(asset.assetType) || !SUPPORTED_TYPES.has(asset.assetType as PublicationMediaAssetType)) {
      throw new Error('Publication media selection is invalid.');
    }
    seenTypes.add(asset.assetType);
    if (
      asset.storageBucket !== privateBucket || !asset.storagePath || asset.storagePath.includes('..') ||
      asset.isPublicApproved || asset.publicUrl !== null || asset.publicStorageBucket !== null ||
      asset.publicStoragePath !== null || !Number.isInteger(asset.fileSizeBytes) || asset.fileSizeBytes <= 0
    ) {
      throw new Error('Publication media source is contradictory.');
    }
    const validation = validateMediaAsset({ fileName: asset.fileName, fileSizeBytes: asset.fileSizeBytes, mimeType: asset.mimeType });
    if (!validation.valid || !/^[A-Za-z0-9_.-]+$/.test(asset.fileName)) {
      throw new Error('Publication media source is invalid.');
    }
    const assetType = asset.assetType as PublicationMediaAssetType;
    const publicPath = buildDeterministicPublicMediaPath(targetPublicId, assetType, asset.fileName);
    const publicUrl = getPublicUrl(publicBucket, publicPath);
    assertPublicUrl(publicUrl, privateBucket);
    mediaPromotions.push({
      mediaAssetId: asset.id,
      assetType,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      fileSizeBytes: asset.fileSizeBytes,
      sourceBucket: asset.storageBucket,
      sourcePath: asset.storagePath,
      publicBucket,
      publicPath,
      publicUrl,
    });
  }

  mediaPromotions.sort((a, b) => a.assetType.localeCompare(b.assetType) || a.publicPath.localeCompare(b.publicPath));

  let projectedTarget = target;
  if (mediaPromotions.length > 0) {
    const poster = mediaPromotions.find((item) => item.assetType === 'poster_image');
    const posterPdf = mediaPromotions.find((item) => item.assetType === 'poster_pdf');
    if (!poster || !posterPdf) throw new Error('Required publication media is missing.');
    projectedTarget = {
      ...target,
      poster: poster.publicUrl,
      posterPdf: posterPdf.publicUrl,
      snapshots: mediaPromotions.filter((item) => item.assetType === 'snapshot_image').map((item) => item.publicUrl),
    };
  } else {
    assertPublicUrl(target.poster, privateBucket);
    assertPublicUrl(target.posterPdf, privateBucket);
    target.snapshots.forEach((url) => assertPublicUrl(url, privateBucket));
  }

  const projectedProjects = projects.map((project) => project.publicId === targetPublicId ? projectedTarget : project);
  const feed = compilePublicationCandidateFeed(projectedProjects, targetPublicId);
  const validation = validatePublicFeed(feed);
  if (!validation.valid) throw new Error('Publication feed validation failed.');
  const artifact = serializePublicFeedArtifact(feed);
  if (artifact.content.includes(privateBucket) || artifact.content.includes('/drafts/')) {
    throw new Error('Publication artifact contains a private media reference.');
  }
  return { feed, ...artifact, mediaPromotions };
}
