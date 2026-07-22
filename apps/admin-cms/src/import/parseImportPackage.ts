import * as fs from 'fs';
import * as path from 'path';
import { ImportPackageParseResult, ImportPackageManifest, ImportPackageFile } from './importTypes';

function getMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

export async function parseLocalImportPackage(packagePath: string): Promise<ImportPackageParseResult> {
  const resolvedPath = path.resolve(packagePath);
  
  // Basic security: Ensure the path points to an actual existing directory
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
    throw new Error(`Import package path is invalid or does not exist: [${packagePath}]`);
  }

  // 1. Read project.json
  const manifestPath = path.join(resolvedPath, 'project.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Import package is missing 'project.json' manifest inside: [${packagePath}]`);
  }

  // Ensure no directory traversal occurred via manifest read
  if (!path.resolve(manifestPath).startsWith(resolvedPath)) {
    throw new Error('Security Error: Path traversal attempt detected while accessing manifest.');
  }

  const manifestContent = fs.readFileSync(manifestPath, 'utf8');
  let manifest: ImportPackageManifest;
  try {
    manifest = JSON.parse(manifestContent);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'JSON parse error';
    throw new Error(`Failed to parse 'project.json': ${message}`);
  }

  // Helper to load safe files from package
  const loadPackageFile = (fileName: string): ImportPackageFile | null => {
    const filePath = path.join(resolvedPath, fileName);
    // Safety check: ensure file path stays within the package folder
    const resolvedFilePath = path.resolve(filePath);
    if (!resolvedFilePath.startsWith(resolvedPath)) {
      throw new Error(`Security Error: Path traversal attempt detected on file [${fileName}]`);
    }

    if (!fs.existsSync(resolvedFilePath)) {
      return null;
    }

    const content = fs.readFileSync(resolvedFilePath);
    return {
      fileName,
      fileSizeBytes: content.length,
      mimeType: getMimeType(fileName),
      content
    };
  };

  // 2. Read expected media files
  const posterImage = loadPackageFile('poster.png');
  const posterPdf = loadPackageFile('poster.pdf');
  const snapshot1 = loadPackageFile('snapshot-1.png');

  return {
    manifest,
    posterImage,
    posterPdf,
    snapshot1
  };
}
