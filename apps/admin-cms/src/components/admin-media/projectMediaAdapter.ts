import type { Project } from '../../domain/project';
import type { MediaPreviewItem } from './mediaPreviewTypes';

type ProjectMediaSource = Pick<
  Project,
  'title' | 'poster' | 'posterPdf' | 'snapshots' | 'accessibilityText'
>;

function getMimeTypeFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();

    if (pathname.endsWith('.png')) {
      return 'image/png';
    }

    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) {
      return 'image/jpeg';
    }

    if (pathname.endsWith('.webp')) {
      return 'image/webp';
    }

    if (pathname.endsWith('.pdf')) {
      return 'application/pdf';
    }

    return 'application/octet-stream';
  } catch {
    return 'application/octet-stream';
  }
}

function getFileNameFromUrl(
  url: string,
  fallback: string,
): string {
  try {
    const pathname = new URL(url).pathname;
    const fileName = pathname.split('/').pop();

    return fileName || fallback;
  } catch {
    return fallback;
  }
}

export function adaptProjectMedia(
  project: ProjectMediaSource,
): MediaPreviewItem[] {
  const mediaItems: MediaPreviewItem[] = [];

  if (project.poster) {
    mediaItems.push({
      url: project.poster,
      fileName: getFileNameFromUrl(
        project.poster,
        'project-poster',
      ),
      mimeType: getMimeTypeFromUrl(project.poster),
      altText:
        project.accessibilityText?.trim() ||
        `Poster preview for ${project.title}`,
    });
  }

  if (project.posterPdf) {
    mediaItems.push({
      url: project.posterPdf,
      fileName: getFileNameFromUrl(
        project.posterPdf,
        'project-poster.pdf',
      ),
      mimeType: getMimeTypeFromUrl(project.posterPdf),
    });
  }

  project.snapshots?.forEach((snapshotUrl, index) => {
    mediaItems.push({
      url: snapshotUrl,
      fileName: getFileNameFromUrl(
        snapshotUrl,
        `project-snapshot-${index + 1}`,
      ),
      mimeType: getMimeTypeFromUrl(snapshotUrl),
      altText: `Project snapshot ${index + 1} for ${project.title}`,
    });
  });

  return mediaItems;
}