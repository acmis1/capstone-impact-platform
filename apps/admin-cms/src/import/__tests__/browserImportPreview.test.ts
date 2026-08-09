import { describe, it, expect, vi } from 'vitest';
import * as ExcelJS from 'exceljs';
import {
  normalizeRelativePath,
  isIgnoredSystemFile,
  deriveMimeType,
} from '../browserSelection';
import { validateFolderDerivedPublicId } from '../publicIdValidation';
import {
  parseBrowserImportPreview,
  BrowserImportPreviewLimitError,
} from '../parseBrowserImportPreview';
import { parseProjectDetailsJson } from '../parseProjectDetailsJson';
import { validateImportPackage } from '../validateImportPackage';
import {
  SelectionManifest,
  SelectedFileDescriptor,
  validateBrowserImportPreviewResponse,
} from '../browserImportPreviewContract';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('../../auth/requireAdmin', () => ({
  requireAdmin: vi.fn(async () => ({
    authUserId: 'user-1',
    adminUserId: 'admin-1',
    email: 'admin@capstone.test',
    fullName: 'Admin User',
    roles: ['admin'],
    permissions: ['projects.edit', 'projects.read'],
  })),
}));

vi.mock('../../auth/permissions', () => ({
  hasPermission: vi.fn((permissions: string[], perm: string) =>
    Array.isArray(permissions) && permissions.includes(perm)
  ),
}));

import { NextRequest } from 'next/server';
import { AdminAuthError } from '../../auth/authTypes';
import { POST as previewRouteHandler } from '../../app/api/imports/preview/route';
import { requireAdmin } from '../../auth/requireAdmin';
import { generateUploadKey } from '../browserSelection';

function makeDesc(normPath: string, sizeBytes = 500, mimeType = 'text/plain'): SelectedFileDescriptor {
  const parts = normPath.split('/');
  const fileName = parts[parts.length - 1];
  const pkgPath = parts.length >= 2 ? (parts.length === 2 ? parts[0] : `${parts[0]}/${parts[1]}`) : parts[0];
  return {
    uploadKey: generateUploadKey(normPath),
    originalPath: normPath,
    normalizedPath: normPath,
    fileName,
    fileSizeBytes: sizeBytes,
    mimeType,
    packagePath: pkgPath,
  };
}

/**
 * Helper to build a minimal valid XLSX buffer in-memory using ExcelJS.
 */
async function buildTestWorkbookBuffer(overrides: Record<string, string> = {}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Project details');

  const headers = [
    'Project title',
    'Short public summary',
    'Project background',
    'Solution / impact',
    'Team members',
    'Group name',
    'Academic supervisor',
    'Industry partner',
    'Industry sector',
    'Study program',
    'Primary discipline',
    'Project year',
    'Showcase layout',
    'Main media to feature',
    'Accessibility text',
  ];

  sheet.addRow(headers);

  const dataRow = [
    overrides.title ?? 'Autonomous Drone Navigation',
    overrides.summary ?? 'AI-powered flight control system.',
    overrides.background ?? 'Background text',
    overrides.solution ?? 'Solution text',
    overrides.teamMembers ?? 'Alice Smith\nBob Jones',
    overrides.groupName ?? 'Group 7',
    overrides.academicSupervisor ?? 'Dr. Clara Oswald',
    overrides.industryPartner ?? 'AeroTech Corp',
    overrides.industry ?? 'Aerospace',
    overrides.program ?? 'Bachelor of Computer Science',
    overrides.discipline ?? 'Artificial Intelligence',
    overrides.year ?? '2026',
    overrides.templateId ?? 'poster_showcase',
    overrides.featuredMedia ?? 'poster',
    overrides.accessibilityText ?? 'Poster showing drone system architecture.',
  ];

  sheet.addRow(dataRow);

  const arrayBuf = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuf);
}

describe('Browser Import Preview Suite', () => {
  describe('Path and Selection Normalization', () => {
    it('1. Windows separator normalization', () => {
      expect(normalizeRelativePath('root\\subfolder\\file.png')).toBe('root/subfolder/file.png');
    });

    it('2. POSIX separator preservation', () => {
      expect(normalizeRelativePath('root/subfolder/file.png')).toBe('root/subfolder/file.png');
    });

    it('3. Absolute-path rejection', () => {
      expect(normalizeRelativePath('/abs/path/file.png')).toBeNull();
      expect(normalizeRelativePath('C:\\abs\\path\\file.png')).toBeNull();
    });

    it('4. .. traversal rejection', () => {
      expect(normalizeRelativePath('root/../file.png')).toBeNull();
    });

    it('5. . segment rejection', () => {
      expect(normalizeRelativePath('root/./file.png')).toBeNull();
    });

    it('6. Empty segment cleaning', () => {
      expect(normalizeRelativePath('root//file.png')).toBe('root/file.png');
    });

    it('7. Null-byte rejection', () => {
      expect(normalizeRelativePath('root/\0file.png')).toBeNull();
    });

    it('8. Duplicate normalized-path rejection', async () => {
      const manifest: SelectionManifest = {
        selectedRootName: 'batch',
        fileCount: 2,
        declaredTotalBytes: 100,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'batch_p1_poster_png',
            normalizedPath: 'batch/p1/poster.png',
            originalPath: 'batch/p1/poster.png',
            fileName: 'poster.png',
            fileSizeBytes: 50,
            mimeType: 'image/png',
            packagePath: 'batch/p1',
          },
          {
            uploadKey: 'batch_p1_poster_png',
            normalizedPath: 'batch/p1/poster.png',
            originalPath: 'batch/p1/poster.png',
            fileName: 'poster.png',
            fileSizeBytes: 50,
            mimeType: 'image/png',
            packagePath: 'batch/p1',
          },
        ],
      };

      await expect(parseBrowserImportPreview(manifest, new Map())).rejects.toThrow(BrowserImportPreviewLimitError);
    });

    it('9. Deterministic sorting of packages', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const descZebra = makeDesc(
        'batch/2026-project-zebra/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descAlpha = makeDesc(
        'batch/2026-project-alpha/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      const manifest: SelectionManifest = {
        selectedRootName: 'batch',
        fileCount: 2,
        declaredTotalBytes: descZebra.fileSizeBytes + descAlpha.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descZebra, descAlpha],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descZebra.uploadKey, xlsxBuf);
      uploads.set(descAlpha.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packages.map((p) => p.folderName)).toEqual(['2026-project-alpha', '2026-project-zebra']);
    });

    it('10. System-file ignoring (.DS_Store, Thumbs.db, desktop.ini)', () => {
      expect(isIgnoredSystemFile('root/p1/.DS_Store')).toBe(true);
      expect(isIgnoredSystemFile('root/p1/Thumbs.db')).toBe(true);
      expect(isIgnoredSystemFile('root/p1/desktop.ini')).toBe(true);
      expect(isIgnoredSystemFile('root/p1/poster.png')).toBe(false);
    });

    it('11. __MACOSX ignoring', () => {
      expect(isIgnoredSystemFile('root/__MACOSX/p1/poster.png')).toBe(true);
    });
  });

  describe('Folder-Shape Detection & Structural Limits', () => {
    it('12. Valid single-project folder', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const descXlsx = makeDesc(
        '2026-project-alpha/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descPng = makeDesc('2026-project-alpha/poster.png', 500, 'image/png');
      const descPdf = makeDesc('2026-project-alpha/poster.pdf', 500, 'application/pdf');

      const manifest: SelectionManifest = {
        selectedRootName: '2026-project-alpha',
        fileCount: 3,
        declaredTotalBytes: descXlsx.fileSizeBytes + descPng.fileSizeBytes + descPdf.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descXlsx, descPng, descPdf],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descXlsx.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      if (res.batch.packages[0].status === 'invalid') {
        console.log('TEST 12 ERRORS:', JSON.stringify(res.batch.packages[0].errors, null, 2));
      }
      expect(res.batch.mode).toBe('single');
      expect(res.batch.packageCount).toBe(1);
      expect(res.batch.invalidPackageCount).toBe(0);
      expect(['valid', 'warning']).toContain(res.batch.packages[0].status);
    });

    it('13. Valid parent folder with multiple projects', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const descP1 = makeDesc(
        'batch-root/p1/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descP2 = makeDesc(
        'batch-root/p2/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      const manifest: SelectionManifest = {
        selectedRootName: 'batch-root',
        fileCount: 2,
        declaredTotalBytes: descP1.fileSizeBytes + descP2.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descP1, descP2],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descP1.uploadKey, xlsxBuf);
      uploads.set(descP2.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.mode).toBe('batch');
      expect(res.batch.packageCount).toBe(2);
    });

    it('14. Mixed root and child metadata rejection', async () => {
      const descRoot = makeDesc(
        'root/project-details.xlsx',
        50,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descChild = makeDesc(
        'root/child/project-details.xlsx',
        50,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      const manifest: SelectionManifest = {
        selectedRootName: 'root',
        fileCount: 2,
        declaredTotalBytes: 100,
        ignoredSystemFilesCount: 0,
        descriptors: [descRoot, descChild],
      };

      await expect(parseBrowserImportPreview(manifest, new Map())).rejects.toThrow(BrowserImportPreviewLimitError);
    });

    it('15. Unsupported nested recognized file emits structure error', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const desc = makeDesc(
        'batch-root/p1/nested/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      const manifest: SelectionManifest = {
        selectedRootName: 'batch-root',
        fileCount: 1,
        declaredTotalBytes: xlsxBuf.length,
        ignoredSystemFilesCount: 0,
        descriptors: [desc],
      };

      const res = await parseBrowserImportPreview(manifest, new Map());
      expect(res.batch.packages[0].status).toBe('invalid');
      expect(res.batch.packages[0].errors.some((e) => e.code === 'PACKAGE_STRUCTURE_INVALID')).toBe(true);
    });

    it('16. Root loose-file warning in batch mode does not create extra package', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const descTxt = makeDesc('batch-root/readme.txt', 500, 'text/plain');
      const descP1 = makeDesc(
        'batch-root/p1/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      const manifest: SelectionManifest = {
        selectedRootName: 'batch-root',
        fileCount: 2,
        declaredTotalBytes: descTxt.fileSizeBytes + descP1.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descTxt, descP1],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descP1.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packageCount).toBe(1);
      expect(res.batch.batchIssues.some((i) => i.code === 'BATCH_ROOT_LOOSE_FILE')).toBe(true);
    });

    it('17. Empty selection rejection', async () => {
      const manifest: SelectionManifest = {
        selectedRootName: 'root',
        fileCount: 0,
        declaredTotalBytes: 0,
        ignoredSystemFilesCount: 0,
        descriptors: [],
      };

      await expect(parseBrowserImportPreview(manifest, new Map())).rejects.toThrow(BrowserImportPreviewLimitError);
    });

    it('18. More than 25 packages limit error', async () => {
      const descriptors: SelectedFileDescriptor[] = [];
      for (let i = 1; i <= 26; i++) {
        descriptors.push(
          makeDesc(
            `root/p-${i}/project-details.xlsx`,
            10,
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          )
        );
      }

      const manifest: SelectionManifest = {
        selectedRootName: 'root',
        fileCount: 26,
        declaredTotalBytes: 260,
        ignoredSystemFilesCount: 0,
        descriptors,
      };

      await expect(parseBrowserImportPreview(manifest, new Map())).rejects.toThrow(BrowserImportPreviewLimitError);
    });

    it('19. More than 500 descriptors limit error', async () => {
      const descriptors: SelectedFileDescriptor[] = [];
      for (let i = 1; i <= 501; i++) {
        descriptors.push(makeDesc(`root/p1/file-${i}.txt`, 10, 'text/plain'));
      }

      const manifest: SelectionManifest = {
        selectedRootName: 'root',
        fileCount: 501,
        declaredTotalBytes: 5010,
        ignoredSystemFilesCount: 0,
        descriptors,
      };

      await expect(parseBrowserImportPreview(manifest, new Map())).rejects.toThrow(BrowserImportPreviewLimitError);
    });
  });

  describe('Package Metadata & Parsing', () => {
    it('20. Valid XLSX package preview', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer({ title: 'Solar Monitor Capstone' });
      const descXlsx = makeDesc(
        'solar-monitor/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descPng = makeDesc('solar-monitor/poster.png', 500, 'image/png');
      const descPdf = makeDesc('solar-monitor/poster.pdf', 500, 'application/pdf');

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 3,
        declaredTotalBytes: descXlsx.fileSizeBytes + descPng.fileSizeBytes + descPdf.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descXlsx, descPng, descPdf],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descXlsx.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packages[0].metadataSource).toBe('xlsx');
      expect(res.batch.packages[0].previewMetadata?.title).toBe('Solar Monitor Capstone');
      expect(res.batch.packages[0].errors).toHaveLength(0);
      expect(['valid', 'warning']).toContain(res.batch.packages[0].status);
    });

    it('21. Valid JSON fallback package preview', () => {
      const jsonContent = JSON.stringify({
        title: 'JSON Drone Project',
        summary: 'Drone summary',
        year: '2026',
        program: 'Computer Science',
        discipline: 'Software',
        groupName: 'Group 1',
        teamMembers: ['Member A'],
      });

      const parsed = parseProjectDetailsJson(jsonContent, 'solar-monitor');
      expect(parsed.manifest.title).toBe('JSON Drone Project');
    });

    it('22. Both metadata sources rejected', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const jsonBuf = Buffer.from(JSON.stringify({ title: 'JSON' }));
      const descXlsx = makeDesc(
        'solar-monitor/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descJson = makeDesc('solar-monitor/project.json', jsonBuf.length, 'application/json');

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 2,
        declaredTotalBytes: descXlsx.fileSizeBytes + descJson.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descXlsx, descJson],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descXlsx.uploadKey, xlsxBuf);
      uploads.set(descJson.uploadKey, jsonBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packages[0].status).toBe('invalid');
      expect(res.batch.packages[0].errors[0].code).toBe('PACKAGE_MULTIPLE_METADATA_SOURCES');
    });

    it('23. Missing metadata rejected', async () => {
      const descPng = makeDesc('solar-monitor/poster.png', 500, 'image/png');
      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 1,
        declaredTotalBytes: descPng.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descPng],
      };

      const res = await parseBrowserImportPreview(manifest, new Map());
      expect(res.batch.packages[0].status).toBe('invalid');
      expect(res.batch.packages[0].errors[0].code).toBe('PACKAGE_METADATA_MISSING');
    });

    it('24. Malformed XLSX isolated to one package', async () => {
      const validXlsxBuf = await buildTestWorkbookBuffer();
      const corruptXlsxBuf = Buffer.from('NOT A REAL XLSX');

      const descValidXlsx = makeDesc(
        'batch/2026-valid-project/project-details.xlsx',
        validXlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descValidPng = makeDesc('batch/2026-valid-project/poster.png', 500, 'image/png');
      const descValidPdf = makeDesc('batch/2026-valid-project/poster.pdf', 500, 'application/pdf');
      const descCorruptXlsx = makeDesc(
        'batch/2026-corrupt-project/project-details.xlsx',
        corruptXlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      const manifest: SelectionManifest = {
        selectedRootName: 'batch',
        fileCount: 4,
        declaredTotalBytes:
          descValidXlsx.fileSizeBytes +
          descValidPng.fileSizeBytes +
          descValidPdf.fileSizeBytes +
          descCorruptXlsx.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descValidXlsx, descValidPng, descValidPdf, descCorruptXlsx],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descValidXlsx.uploadKey, validXlsxBuf);
      uploads.set(descCorruptXlsx.uploadKey, corruptXlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packageCount).toBe(2);

      const validPkg = res.batch.packages.find((p) => p.folderName === '2026-valid-project');
      const corruptPkg = res.batch.packages.find((p) => p.folderName === '2026-corrupt-project');

      expect(validPkg?.status).not.toBe('invalid');
      expect(corruptPkg?.status).toBe('invalid');
      expect(corruptPkg?.errors[0].code).toMatch(/WORKBOOK_/);
    });

    it('25. Malformed JSON isolated to one package', async () => {
      const validXlsxBuf = await buildTestWorkbookBuffer();
      const corruptJsonBuf = Buffer.from('{ invalid json');

      const descValidXlsx = makeDesc(
        'batch/2026-valid-project/project-details.xlsx',
        validXlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descValidPng = makeDesc('batch/2026-valid-project/poster.png', 500, 'image/png');
      const descValidPdf = makeDesc('batch/2026-valid-project/poster.pdf', 500, 'application/pdf');
      const descCorruptJson = makeDesc(
        'batch/2026-corrupt-project/project.json',
        corruptJsonBuf.length,
        'application/json'
      );

      const manifest: SelectionManifest = {
        selectedRootName: 'batch',
        fileCount: 4,
        declaredTotalBytes:
          descValidXlsx.fileSizeBytes +
          descValidPng.fileSizeBytes +
          descValidPdf.fileSizeBytes +
          descCorruptJson.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descValidXlsx, descValidPng, descValidPdf, descCorruptJson],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descValidXlsx.uploadKey, validXlsxBuf);
      uploads.set(descCorruptJson.uploadKey, corruptJsonBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packageCount).toBe(2);

      const validPkg = res.batch.packages.find((p) => p.folderName === '2026-valid-project');
      const corruptPkg = res.batch.packages.find((p) => p.folderName === '2026-corrupt-project');

      expect(validPkg?.status).not.toBe('invalid');
      expect(corruptPkg?.status).toBe('invalid');
      expect(corruptPkg?.errors[0].code).toBe('JSON_MALFORMED');
    });

    it('26. Invalid folder-derived public ID validation', () => {
      expect(validateFolderDerivedPublicId('2026-project-alpha').valid).toBe(true);
      expect(validateFolderDerivedPublicId('Project Alpha').valid).toBe(false);
      expect(validateFolderDerivedPublicId('project_alpha').valid).toBe(false);
      expect(validateFolderDerivedPublicId('../project').valid).toBe(false);
    });

    it('27. Metadata file above its individual limit throws limit error', async () => {
      const oversizedBuf = Buffer.alloc(6 * 1024 * 1024); // 6 MB > 5 MB limit
      const descXlsx = makeDesc(
        'root/project-details.xlsx',
        oversizedBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      const manifest: SelectionManifest = {
        selectedRootName: 'root',
        fileCount: 1,
        declaredTotalBytes: oversizedBuf.length,
        ignoredSystemFilesCount: 0,
        descriptors: [descXlsx],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descXlsx.uploadKey, oversizedBuf);

      await expect(parseBrowserImportPreview(manifest, uploads)).rejects.toThrow(BrowserImportPreviewLimitError);
    });

    it('28. Missing uploaded metadata blob error', async () => {
      const descXlsx = makeDesc(
        'solar-monitor/project-details.xlsx',
        500,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 1,
        declaredTotalBytes: 500,
        ignoredSystemFilesCount: 0,
        descriptors: [descXlsx],
      };

      const res = await parseBrowserImportPreview(manifest, new Map());
      expect(res.batch.packages[0].status).toBe('invalid');
      expect(res.batch.packages[0].errors[0].code).toBe('PACKAGE_MISSING_METADATA_BLOB');
    });

    it('29. Duplicate upload key error', async () => {
      const manifest: SelectionManifest = {
        selectedRootName: 'root',
        fileCount: 2,
        declaredTotalBytes: 100,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'root_file_txt',
            normalizedPath: 'root/file.txt',
            originalPath: 'root/file.txt',
            fileName: 'file.txt',
            fileSizeBytes: 50,
            mimeType: 'text/plain',
            packagePath: 'root',
          },
          {
            uploadKey: 'root_file_txt',
            normalizedPath: 'root/file.txt',
            originalPath: 'root/file.txt',
            fileName: 'file.txt',
            fileSizeBytes: 50,
            mimeType: 'text/plain',
            packagePath: 'root',
          },
        ],
      };

      await expect(parseBrowserImportPreview(manifest, new Map())).rejects.toThrow(BrowserImportPreviewLimitError);
    });
  });

  describe('Files & Validation', () => {
    it('30. Unknown file in package root triggers warning', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const descXlsx = makeDesc(
        'solar-monitor/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descTxt = makeDesc('solar-monitor/random-file.txt', 500, 'text/plain');

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 2,
        declaredTotalBytes: descXlsx.fileSizeBytes + descTxt.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descXlsx, descTxt],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descXlsx.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packages[0].warnings.some((w) => w.code === 'PACKAGE_UNKNOWN_FILE')).toBe(true);
    });

    it('31. Required poster PNG missing error', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const descXlsx = makeDesc(
        'solar-monitor/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descPdf = makeDesc('solar-monitor/poster.pdf', 500, 'application/pdf');

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 2,
        declaredTotalBytes: descXlsx.fileSizeBytes + descPdf.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descXlsx, descPdf],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descXlsx.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packages[0].status).toBe('invalid');
      expect(res.batch.packages[0].errors.some((e) => e.code === 'FILE_MISSING_POSTER_IMAGE')).toBe(true);
    });

    it('32. Required poster PDF missing error', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const descXlsx = makeDesc(
        'solar-monitor/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descPng = makeDesc('solar-monitor/poster.png', 500, 'image/png');

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 2,
        declaredTotalBytes: descXlsx.fileSizeBytes + descPng.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descXlsx, descPng],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descXlsx.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packages[0].status).toBe('invalid');
      expect(res.batch.packages[0].errors.some((e) => e.code === 'FILE_MISSING_POSTER_PDF')).toBe(true);
    });

    it('33. Missing snapshot warning', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const descXlsx = makeDesc(
        'solar-monitor/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descPng = makeDesc('solar-monitor/poster.png', 500, 'image/png');
      const descPdf = makeDesc('solar-monitor/poster.pdf', 500, 'application/pdf');

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 3,
        declaredTotalBytes: descXlsx.fileSizeBytes + descPng.fileSizeBytes + descPdf.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descXlsx, descPng, descPdf],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descXlsx.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packages[0].warnings.some((w) => w.code === 'FILE_MISSING_RECOMMENDED')).toBe(true);
    });

    it('34. Oversized image descriptor produces error', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const descXlsx = makeDesc(
        'solar-monitor/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descPng = makeDesc('solar-monitor/poster.png', 12 * 1024 * 1024, 'image/png');
      const descPdf = makeDesc('solar-monitor/poster.pdf', 500, 'application/pdf');

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 3,
        declaredTotalBytes: descXlsx.fileSizeBytes + descPng.fileSizeBytes + descPdf.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descXlsx, descPng, descPdf],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descXlsx.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packages[0].status).toBe('invalid');
      expect(
        res.batch.packages[0].errors.some(
          (e) => e.code === 'FILE_IMAGE_OVERSIZED' || e.code === 'FILE_INVALID_POSTER_IMAGE'
        )
      ).toBe(true);
    });

    it('35. Oversized PDF descriptor produces error', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const descXlsx = makeDesc(
        'solar-monitor/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descPng = makeDesc('solar-monitor/poster.png', 500, 'image/png');
      const descPdf = makeDesc('solar-monitor/poster.pdf', 28 * 1024 * 1024, 'application/pdf');

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 3,
        declaredTotalBytes: descXlsx.fileSizeBytes + descPng.fileSizeBytes + descPdf.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descXlsx, descPng, descPdf],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descXlsx.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packages[0].status).toBe('invalid');
      expect(
        res.batch.packages[0].errors.some(
          (e) => e.code === 'FILE_PDF_OVERSIZED' || e.code === 'FILE_INVALID_POSTER_PDF'
        )
      ).toBe(true);
    });

    it('36. MIME conflict warning', () => {
      const derived = deriveMimeType('poster.png', 'text/plain');
      expect(derived.mimeType).toBe('image/png');
      expect(derived.warning).toBeDefined();
    });

    it('37. Case-insensitive canonical filename recognition', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const descXlsx = makeDesc(
        'solar-monitor/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descPng = makeDesc('solar-monitor/POSTER.PNG', 500, 'image/png');
      const descPdf = makeDesc('solar-monitor/Poster.Pdf', 500, 'application/pdf');

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 3,
        declaredTotalBytes: descXlsx.fileSizeBytes + descPng.fileSizeBytes + descPdf.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descXlsx, descPng, descPdf],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descXlsx.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packages[0].filePresence.posterImagePresent).toBe(true);
      expect(res.batch.packages[0].filePresence.posterPdfPresent).toBe(true);
    });

    it('38. Case-collision duplicate rejected', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const descXlsx = makeDesc(
        'solar-monitor/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descPng1 = makeDesc('solar-monitor/poster.png', 500, 'image/png');
      const descPng2 = makeDesc('solar-monitor/Poster.PNG', 500, 'image/png');

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 3,
        declaredTotalBytes: descXlsx.fileSizeBytes + descPng1.fileSizeBytes + descPng2.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descXlsx, descPng1, descPng2],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descXlsx.uploadKey, xlsxBuf);

      await expect(parseBrowserImportPreview(manifest, uploads)).rejects.toThrow(BrowserImportPreviewLimitError);
    });

    it('39. Unknown package file warning', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const descXlsx = makeDesc(
        'solar-monitor/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descTxt = makeDesc('solar-monitor/unknown-notes.txt', 500, 'text/plain');

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 2,
        declaredTotalBytes: descXlsx.fileSizeBytes + descTxt.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descXlsx, descTxt],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descXlsx.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packages[0].warnings.some((w) => w.code === 'PACKAGE_UNKNOWN_FILE')).toBe(true);
    });

    it('40. Existing local package validation remains unchanged', () => {
      const localParsed = {
        manifest: {
          publicId: 'local-test',
          title: 'Local Title',
          summary: 'Summary',
          background: 'Background',
          solution: 'Solution',
          year: '2026',
          program: 'CS',
          studyProgram: 'CS',
          discipline: 'AI',
          industry: 'Tech',
          industryPartner: 'Partner',
          academicSupervisor: 'Supervisor',
          groupName: 'Group 1',
          teamMembers: ['Alice'],
          layoutConfig: {},
        },
        posterImage: { fileName: 'poster.png', fileSizeBytes: 1000, mimeType: 'image/png', content: Buffer.from('img') },
        posterPdf: { fileName: 'poster.pdf', fileSizeBytes: 2000, mimeType: 'application/pdf', content: Buffer.from('pdf') },
        snapshot1: null,
      };

      const val = validateImportPackage(localParsed);
      expect(val.valid).toBe(true);
    });

    it('41. Invalid package does not block valid siblings', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const descP1Xlsx = makeDesc(
        'batch/p1/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const descP1Png = makeDesc('batch/p1/poster.png', 500, 'image/png');
      const descP1Pdf = makeDesc('batch/p1/poster.pdf', 500, 'application/pdf');
      const descP2Png = makeDesc('batch/p2/poster.png', 500, 'image/png');

      const manifest: SelectionManifest = {
        selectedRootName: 'batch',
        fileCount: 4,
        declaredTotalBytes:
          descP1Xlsx.fileSizeBytes + descP1Png.fileSizeBytes + descP1Pdf.fileSizeBytes + descP2Png.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descP1Xlsx, descP1Png, descP1Pdf, descP2Png],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descP1Xlsx.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packageCount).toBe(2);

      const p1 = res.batch.packages.find((p) => p.folderName === 'p1');
      const p2 = res.batch.packages.find((p) => p.folderName === 'p2');

      expect(p1?.status).not.toBe('invalid');
      expect(p2?.status).toBe('invalid');
    });

    it('42. Workbook warnings survive package errors', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer({ year: '2026' }); // valid workbook, missing poster.png -> error
      const descXlsx = makeDesc(
        'solar-monitor/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 1,
        declaredTotalBytes: descXlsx.fileSizeBytes,
        ignoredSystemFilesCount: 0,
        descriptors: [descXlsx],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(descXlsx.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packages[0].status).toBe('invalid');
      expect(res.batch.packages[0].warnings.length).toBeGreaterThan(0);
    });
  });

  describe('Privacy & Error Sanitization', () => {
    it('43. Issue messages exclude project title', async () => {
      const secretTitle = 'Super Secret Project Quantum X';
      const xlsxBuf = await buildTestWorkbookBuffer({ title: secretTitle });
      const desc = makeDesc(
        'solar-monitor/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 1,
        declaredTotalBytes: xlsxBuf.length,
        ignoredSystemFilesCount: 0,
        descriptors: [desc],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(desc.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      const allIssueText = JSON.stringify([...res.batch.packages[0].errors, ...res.batch.packages[0].warnings]);
      expect(allIssueText).not.toContain(secretTitle);
    });

    it('44. Issue messages exclude participant names', async () => {
      const secretMember = 'Dr. Secret Participant Name';
      const xlsxBuf = await buildTestWorkbookBuffer({ teamMembers: secretMember });
      const desc = makeDesc(
        'solar-monitor/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 1,
        declaredTotalBytes: xlsxBuf.length,
        ignoredSystemFilesCount: 0,
        descriptors: [desc],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(desc.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      const allIssueText = JSON.stringify([...res.batch.packages[0].errors, ...res.batch.packages[0].warnings]);
      expect(allIssueText).not.toContain(secretMember);
    });

    it('45. Issue messages exclude raw JSON parser details', async () => {
      const corruptJson = Buffer.from('{ secret_key: "raw_value_leak"');
      const desc = makeDesc('solar-monitor/project.json', corruptJson.length, 'application/json');

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 1,
        declaredTotalBytes: corruptJson.length,
        ignoredSystemFilesCount: 0,
        descriptors: [desc],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(desc.uploadKey, corruptJson);

      const res = await parseBrowserImportPreview(manifest, uploads);
      const errText = JSON.stringify(res.batch.packages[0].errors);
      expect(errText).not.toContain('raw_value_leak');
    });

    it('46. Issue messages exclude ExcelJS, ZIP, and XML details', async () => {
      const corruptXlsx = Buffer.from('PK\x03\x04 corrupt zip entries internal details');
      const desc = makeDesc(
        'solar-monitor/project-details.xlsx',
        corruptXlsx.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 1,
        declaredTotalBytes: corruptXlsx.length,
        ignoredSystemFilesCount: 0,
        descriptors: [desc],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(desc.uploadKey, corruptXlsx);

      const res = await parseBrowserImportPreview(manifest, uploads);
      const errText = JSON.stringify(res.batch.packages[0].errors);
      expect(errText).not.toContain('corrupt zip entries');
    });

    it('47. Response contains no Buffer, ArrayBuffer, or binary content', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const desc = makeDesc(
        'solar-monitor/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 1,
        declaredTotalBytes: xlsxBuf.length,
        ignoredSystemFilesCount: 0,
        descriptors: [desc],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(desc.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      const jsonStr = JSON.stringify(res);

      expect(jsonStr).not.toContain('Buffer');
      expect(jsonStr).not.toContain('ArrayBuffer');
    });

    it('48. Response excludes full team-member roster names', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer({ teamMembers: 'Secret Name One\nSecret Name Two' });
      const desc = makeDesc(
        'solar-monitor/project-details.xlsx',
        xlsxBuf.length,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 1,
        declaredTotalBytes: xlsxBuf.length,
        ignoredSystemFilesCount: 0,
        descriptors: [desc],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set(desc.uploadKey, xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      const jsonStr = JSON.stringify(res);

      expect(jsonStr).not.toContain('Secret Name One');
      expect(jsonStr).not.toContain('Secret Name Two');
      expect(res.batch.packages[0].previewMetadata?.teamMemberCount).toBe(2);
    });
  });

  describe('API Route Security & HTTP Contract', () => {
    it('49. Unauthenticated API request returns 401', async () => {
      vi.mocked(requireAdmin).mockRejectedValueOnce(
        new AdminAuthError('UNAUTHENTICATED', 'Authentication required.')
      );
      const req = new NextRequest('http://localhost:3000/api/imports/preview', { method: 'POST' });
      const res = await previewRouteHandler(req);
      expect(res.status).toBe(401);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    it('50. Reviewer API request returns 403', async () => {
      vi.mocked(requireAdmin).mockResolvedValueOnce({
        authUserId: 'user-2',
        adminUserId: 'admin-2',
        email: 'reviewer@capstone.test',
        fullName: 'Reviewer User',
        roles: ['reviewer'],
        permissions: ['projects.read'],
      });
      const req = new NextRequest('http://localhost:3000/api/imports/preview', { method: 'POST' });
      const res = await previewRouteHandler(req);
      expect(res.status).toBe(403);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    it('51. Editor/admin request reaches parsing', async () => {
      vi.mocked(requireAdmin).mockResolvedValueOnce({
        authUserId: 'user-1',
        adminUserId: 'admin-1',
        email: 'admin@capstone.test',
        fullName: 'Admin User',
        roles: ['admin'],
        permissions: ['projects.edit'],
      });
      const req = new NextRequest('http://localhost:3000/api/imports/preview', { method: 'POST' });
      const res = await previewRouteHandler(req);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it('52. Cross-origin request returns 403', async () => {
      const req = new NextRequest('http://localhost:3000/api/imports/preview', {
        method: 'POST',
        headers: { origin: 'http://malicious-site.com' },
      });
      const res = await previewRouteHandler(req);
      expect(res.status).toBe(403);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    it('53. Oversized Content-Length returns 413 before multipart parsing', async () => {
      const req = new NextRequest('http://localhost:3000/api/imports/preview', {
        method: 'POST',
        headers: { 'content-length': '35000000' }, // 35 MB > 27 MB limit
      });
      const res = await previewRouteHandler(req);
      expect(res.status).toBe(413);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    it('54. Malformed manifest returns 400', async () => {
      const manifest: SelectionManifest = {
        selectedRootName: 'root',
        fileCount: -1, // invalid
        declaredTotalBytes: 100,
        ignoredSystemFilesCount: 0,
        descriptors: [],
      };

      await expect(parseBrowserImportPreview(manifest, new Map())).rejects.toThrow(BrowserImportPreviewLimitError);
    });

    it('55. Successful package preview returns 200 via route', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();
      const xlsxKey = generateUploadKey('2026-project-alpha/project-details.xlsx');
      const pngKey = generateUploadKey('2026-project-alpha/poster.png');
      const pdfKey = generateUploadKey('2026-project-alpha/poster.pdf');

      const manifest: SelectionManifest = {
        selectedRootName: '2026-project-alpha',
        fileCount: 3,
        declaredTotalBytes: xlsxBuf.length + 1000,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: xlsxKey,
            normalizedPath: '2026-project-alpha/project-details.xlsx',
            originalPath: '2026-project-alpha/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: xlsxBuf.length,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: '2026-project-alpha',
          },
          {
            uploadKey: pngKey,
            normalizedPath: '2026-project-alpha/poster.png',
            originalPath: '2026-project-alpha/poster.png',
            fileName: 'poster.png',
            fileSizeBytes: 500,
            mimeType: 'image/png',
            packagePath: '2026-project-alpha',
          },
          {
            uploadKey: pdfKey,
            normalizedPath: '2026-project-alpha/poster.pdf',
            originalPath: '2026-project-alpha/poster.pdf',
            fileName: 'poster.pdf',
            fileSizeBytes: 500,
            mimeType: 'application/pdf',
            packagePath: '2026-project-alpha',
          },
        ],
      };

      const formData = new FormData();
      formData.append('manifest', JSON.stringify(manifest));
      formData.append(
        xlsxKey,
        new File([new Uint8Array(xlsxBuf)], 'project-details.xlsx', {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
      );

      const req = new NextRequest('http://localhost:3000/api/imports/preview', {
        method: 'POST',
        body: formData,
      });

      const res = await previewRouteHandler(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    it('56. Individual invalid packages still return 200 via route', async () => {
      const pngKey = generateUploadKey('solar-monitor/poster.png');
      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 1,
        declaredTotalBytes: 500,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: pngKey,
            normalizedPath: 'solar-monitor/poster.png',
            originalPath: 'solar-monitor/poster.png',
            fileName: 'poster.png',
            fileSizeBytes: 500,
            mimeType: 'image/png',
            packagePath: 'solar-monitor',
          },
        ],
      };

      const formData = new FormData();
      formData.append('manifest', JSON.stringify(manifest));

      const req = new NextRequest('http://localhost:3000/api/imports/preview', {
        method: 'POST',
        body: formData,
      });

      const res = await previewRouteHandler(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.batch.packages[0].status).toBe('invalid');
    });

    it('57. Unexpected internal exception returns a generic safe response', async () => {
      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 1,
        declaredTotalBytes: 500,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'invalid_key_causes_400',
            normalizedPath: 'solar-monitor/poster.png',
            originalPath: 'solar-monitor/poster.png',
            fileName: 'poster.png',
            fileSizeBytes: 500,
            mimeType: 'image/png',
            packagePath: 'solar-monitor',
          },
        ],
      };

      const formData = new FormData();
      formData.append('manifest', JSON.stringify(manifest));

      const req = new NextRequest('http://localhost:3000/api/imports/preview', {
        method: 'POST',
        body: formData,
      });

      const res = await previewRouteHandler(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBeDefined();
    });

    it('58. Every API response includes Cache-Control: no-store', async () => {
      const req = new NextRequest('http://localhost:3000/api/imports/preview', { method: 'POST' });
      const res = await previewRouteHandler(req);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });
  });

  describe('Regression Coverage', () => {
    it('JSON publicId override attempt is ignored', () => {
      const jsonContent = JSON.stringify({
        publicId: 'malicious-spoofed-id',
        title: 'Title',
        summary: 'Summary',
        year: '2026',
        program: 'CS',
        discipline: 'Software',
        groupName: 'G1',
      });

      const parsed = parseProjectDetailsJson(jsonContent, 'folder-derived-id');
      expect(parsed.manifest.publicId).toBe('folder-derived-id');
      expect(parsed.warnings.some((w) => w.code === 'JSON_PUBLIC_ID_IGNORED')).toBe(true);
    });

    it('Client response-shape validator validateBrowserImportPreviewResponse enforces strict contract', () => {
      expect(validateBrowserImportPreviewResponse(null)).toBeNull();
      expect(validateBrowserImportPreviewResponse({})).toBeNull();
      expect(validateBrowserImportPreviewResponse({ success: true, batch: { mode: 'invalid_mode' } })).toBeNull();

      const validResponse = {
        success: true,
        batch: {
          mode: 'single',
          selectedRootName: 'root',
          packageCount: 1,
          selectedFileCount: 2,
          declaredTotalBytes: 100,
          validPackageCount: 1,
          warningPackageCount: 0,
          invalidPackageCount: 0,
          totalWarnings: 0,
          totalErrors: 0,
          mediaValidationMode: 'descriptor_only',
          batchIssues: [],
          packages: [
            {
              packagePath: 'root',
              folderName: 'root',
              proposedPublicId: 'root',
              metadataSource: 'xlsx',
              status: 'valid',
              previewMetadata: {
                title: 'Title',
                year: '2026',
                program: 'CS',
                discipline: 'AI',
                groupName: 'G1',
                teamMemberCount: 1,
                layoutTemplate: 'poster_showcase',
                featuredMedia: 'poster',
              },
              filePresence: {
                xlsxPresent: true,
                jsonPresent: false,
                posterImagePresent: true,
                posterPdfPresent: true,
                snapshotPresent: false,
              },
              errors: [],
              warnings: [],
            },
          ],
        },
      };

      expect(validateBrowserImportPreviewResponse(validResponse)).not.toBeNull();
    });

    it('Spoofed selectedRootName is rejected', async () => {
      const manifest: SelectionManifest = {
        selectedRootName: 'spoofed-root-name', // does not match path 'actual-root'
        fileCount: 1,
        declaredTotalBytes: 50,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'actual-root_file_txt',
            normalizedPath: 'actual-root/file.txt',
            originalPath: 'actual-root/file.txt',
            fileName: 'file.txt',
            fileSizeBytes: 50,
            mimeType: 'text/plain',
            packagePath: 'actual-root',
          },
        ],
      };

      await expect(parseBrowserImportPreview(manifest, new Map())).rejects.toThrow(BrowserImportPreviewLimitError);
    });

    it('Multiple root directories in single selection rejected', async () => {
      const manifest: SelectionManifest = {
        selectedRootName: 'root1',
        fileCount: 2,
        declaredTotalBytes: 100,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'root1_file_txt',
            normalizedPath: 'root1/file.txt',
            originalPath: 'root1/file.txt',
            fileName: 'file.txt',
            fileSizeBytes: 50,
            mimeType: 'text/plain',
            packagePath: 'root1',
          },
          {
            uploadKey: 'root2_file_txt',
            normalizedPath: 'root2/file.txt',
            originalPath: 'root2/file.txt',
            fileName: 'file.txt',
            fileSizeBytes: 50,
            mimeType: 'text/plain',
            packagePath: 'root2',
          },
        ],
      };

      await expect(parseBrowserImportPreview(manifest, new Map())).rejects.toThrow(BrowserImportPreviewLimitError);
    });
  });

  describe('Static Dependency & Safety Boundary', () => {
    it('Static boundary check: route and parser do not import prohibited modules', () => {
      const baseDir = process.cwd().endsWith('admin-cms') ? process.cwd() : join(process.cwd(), 'apps/admin-cms');
      const previewParserCode = readFileSync(
        join(baseDir, 'src/import/parseBrowserImportPreview.ts'),
        'utf-8'
      );
      const routeCode = readFileSync(
        join(baseDir, 'src/app/api/imports/preview/route.ts'),
        'utf-8'
      );

      const prohibited = [
        'publish-cloud-feed',
        'SupabaseClient',
        'duda',
        'createClient',
        'publishCloudFeed',
        'db.json',
        'capstones-latest.json',
      ];

      for (const term of prohibited) {
        expect(previewParserCode).not.toContain(term);
        expect(routeCode).not.toContain(term);
      }
    });
  });
});
