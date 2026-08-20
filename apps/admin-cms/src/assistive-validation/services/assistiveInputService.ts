import { validateMediaAsset, validateMediaAssetBytes } from '../../storage/mediaValidationCore';

import type { AssistiveDocumentType } from '../domain/inputIdentity';
import { hashAssistiveInput } from '../domain/inputIdentity';
import type { AssistiveAssetRow, AssistiveInputGateway } from '../repositories/assistiveInputRepository';

export interface AssistiveInputSnapshot {
  projectId: string;
  title: string;
  assetId: string;
  documentType: AssistiveDocumentType;
  content: Buffer;
  inputHash: string;
  documentHash: string;
}

function selectAsset(rows: AssistiveAssetRow[]): AssistiveAssetRow | null {
  return rows.find((row) => row.asset_type === 'poster_pdf')
    ?? rows.find((row) => row.asset_type === 'poster_image')
    ?? null;
}

function expectedType(asset: AssistiveAssetRow): { mime: string; documentType: AssistiveDocumentType } | null {
  if (asset.asset_type === 'poster_pdf' && asset.mime_type === 'application/pdf') {
    return { mime: 'application/pdf', documentType: 'PDF' };
  }
  if (asset.asset_type === 'poster_image' && asset.mime_type === 'image/png') {
    return { mime: 'image/png', documentType: 'PNG' };
  }
  if (asset.asset_type === 'poster_image' && asset.mime_type === 'image/jpeg') {
    return { mime: 'image/jpeg', documentType: 'JPEG' };
  }
  return null;
}

export async function loadAssistiveInput(
  gateway: AssistiveInputGateway,
  projectId: string,
  privateBucket: string,
): Promise<AssistiveInputSnapshot | null> {
  const project = await gateway.loadProject(projectId);
  if (!project) return null;
  const asset = selectAsset(await gateway.loadPosterAssets(projectId, privateBucket));
  if (!asset || asset.file_size_bytes === null) return null;
  const type = expectedType(asset);
  if (!type) return null;
  const expectedPrefix = `drafts/${project.public_id}/${asset.asset_type}/`;
  if (!asset.storage_path.startsWith(expectedPrefix) || asset.storage_path.includes('..')) return null;
  const metadataValidation = validateMediaAsset({
    fileName: asset.file_name,
    fileSizeBytes: asset.file_size_bytes,
    mimeType: type.mime,
  });
  if (!metadataValidation.valid) return null;

  const content = await gateway.download(asset.storage_bucket, asset.storage_path);
  const validation = validateMediaAssetBytes({
    fileName: asset.file_name,
    content,
    expectedMimeType: type.mime,
    expectedFileSizeBytes: asset.file_size_bytes,
  });
  if (!validation.valid) return null;
  const identity = hashAssistiveInput({ title: project.title ?? '', documentType: type.documentType, content });
  return {
    projectId: project.id,
    title: project.title ?? '',
    assetId: asset.id,
    documentType: type.documentType,
    content,
    ...identity,
  };
}
