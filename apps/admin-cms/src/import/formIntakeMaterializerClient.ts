import type { FormIntakeMetadata, FormIntakeMediaState } from './formIntakeContract';

export interface MaterializedPackageFiles {
  files: File[];
  selectedRootName: string;
  totalBytes: number;
}

export type MaterializePackageResult =
  | { success: true; package: MaterializedPackageFiles }
  | { success: false; error: string };

/**
 * Creates an in-memory File with a simulated webkitRelativePath for pipeline compatibility.
 */
function createSyntheticPackageFile(
  blob: Blob | File,
  fileName: string,
  relativePath: string,
  type: string
): File {
  const fileObj = new File([blob], fileName, { type });
  try {
    Object.defineProperty(fileObj, 'webkitRelativePath', {
      value: relativePath,
      writable: false,
    });
  } catch {
    // If browser prevents defining property, fileObj.name remains intact
  }
  return fileObj;
}

/**
 * Materializes in-memory package files from form metadata and media files by requesting
 * the canonical project-details.xlsx from the server.
 */
export async function materializeFormIntakePackage(
  metadata: FormIntakeMetadata,
  media: FormIntakeMediaState,
  options: { fetchFn?: typeof fetch } = {}
): Promise<MaterializePackageResult> {
  const fetchFn = options.fetchFn || fetch;
  const publicId = metadata.publicId.trim();

  // Synchronize gallery alt texts, classification, and full text from media state into metadata.
  // Positions without an image must not carry fake accessibility data.
  const enrichedMetadata: FormIntakeMetadata = { ...metadata };
  for (const item of media.galleryImages) {
    const pos = item.position;
    const hasFile = Boolean(item.file);
    const alt = hasFile ? (item.altText || '').trim() : '';
    const kind = hasFile ? (item.contentKind || '') : '';
    const fullText =
      hasFile && item.contentKind === 'text_bearing'
        ? (item.fullText || '').trim()
        : '';

    if (pos === 1) {
      enrichedMetadata.snapshotAltText = alt;
      enrichedMetadata.snapshot1ContentKind = kind;
      enrichedMetadata.snapshot1FullText = fullText;
    } else if (pos === 2) {
      enrichedMetadata.snapshot2AltText = alt;
      enrichedMetadata.snapshot2ContentKind = kind;
      enrichedMetadata.snapshot2FullText = fullText;
    } else if (pos === 3) {
      enrichedMetadata.snapshot3AltText = alt;
      enrichedMetadata.snapshot3ContentKind = kind;
      enrichedMetadata.snapshot3FullText = fullText;
    } else if (pos === 4) {
      enrichedMetadata.snapshot4AltText = alt;
      enrichedMetadata.snapshot4ContentKind = kind;
      enrichedMetadata.snapshot4FullText = fullText;
    } else if (pos === 5) {
      enrichedMetadata.snapshot5AltText = alt;
      enrichedMetadata.snapshot5ContentKind = kind;
      enrichedMetadata.snapshot5FullText = fullText;
    } else if (pos === 6) {
      enrichedMetadata.snapshot6AltText = alt;
      enrichedMetadata.snapshot6ContentKind = kind;
      enrichedMetadata.snapshot6FullText = fullText;
    } else if (pos === 7) {
      enrichedMetadata.snapshot7AltText = alt;
      enrichedMetadata.snapshot7ContentKind = kind;
      enrichedMetadata.snapshot7FullText = fullText;
    } else if (pos === 8) {
      enrichedMetadata.snapshot8AltText = alt;
      enrichedMetadata.snapshot8ContentKind = kind;
      enrichedMetadata.snapshot8FullText = fullText;
    } else if (pos === 9) {
      enrichedMetadata.snapshot9AltText = alt;
      enrichedMetadata.snapshot9ContentKind = kind;
      enrichedMetadata.snapshot9FullText = fullText;
    } else if (pos === 10) {
      enrichedMetadata.snapshot10AltText = alt;
      enrichedMetadata.snapshot10ContentKind = kind;
      enrichedMetadata.snapshot10FullText = fullText;
    }
  }

  let res: Response;
  try {
    res = await fetchFn('/api/imports/form-materialize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(enrichedMetadata),
    });
  } catch {
    return {
      success: false,
      error:
        'Network error while generating project workbook. Please check your connection and try again.',
    };
  }

  if (!res.ok) {
    let errorMessage = 'Failed to generate project workbook.';
    try {
      const errJson = await res.json();
      if (errJson && typeof errJson.error === 'string') {
        errorMessage = errJson.error;
      }
    } catch {
      // Non-JSON response
    }
    return { success: false, error: errorMessage };
  }

  const xlsxBlob = await res.blob();
  const files: File[] = [];

  // 1. Canonical project-details.xlsx
  const xlsxFile = createSyntheticPackageFile(
    xlsxBlob,
    'project-details.xlsx',
    `${publicId}/project-details.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  files.push(xlsxFile);

  // 2. Poster Image
  if (media.posterImage) {
    const posterFile = createSyntheticPackageFile(
      media.posterImage,
      'poster.png',
      `${publicId}/poster.png`,
      media.posterImage.type || 'image/png'
    );
    files.push(posterFile);
  }

  // 3. Poster PDF
  if (media.posterPdf) {
    const pdfFile = createSyntheticPackageFile(
      media.posterPdf,
      'poster.pdf',
      `${publicId}/poster.pdf`,
      'application/pdf'
    );
    files.push(pdfFile);
  }

  // 4. Gallery Snapshot Images
  for (const item of media.galleryImages) {
    if (item.file) {
      const originalExt =
        item.file.name.split('.').pop()?.toLowerCase() || 'png';
      const ext = ['png', 'jpg', 'jpeg', 'webp'].includes(originalExt)
        ? originalExt
        : 'png';
      const snapName = `snapshot-${item.position}.${ext}`;
      const snapFile = createSyntheticPackageFile(
        item.file,
        snapName,
        `${publicId}/${snapName}`,
        item.file.type || 'image/png'
      );
      files.push(snapFile);
    }
  }

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  return {
    success: true,
    package: {
      files,
      selectedRootName: publicId,
      totalBytes,
    },
  };
}
