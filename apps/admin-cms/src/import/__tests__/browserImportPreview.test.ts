import { describe, it, expect } from 'vitest';
import * as ExcelJS from 'exceljs';
import {
  normalizeRelativePath,
  isIgnoredSystemFile,
  deriveMimeType,
  SelectionManifest,
  SelectedFileDescriptor,
} from '../browserSelection';
import { validateFolderDerivedPublicId } from '../publicIdValidation';
import { parseBrowserImportPreview, BrowserImportPreviewLimitError } from '../parseBrowserImportPreview';
import { parseProjectDetailsJson } from '../parseProjectDetailsJson';
import { validateImportPackage } from '../validateImportPackage';
import { readFileSync } from 'fs';
import { join } from 'path';

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

    it('6. Empty segment rejection', () => {
      expect(normalizeRelativePath('root//file.png')).toBeNull();
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
            uploadKey: 'key1',
            normalizedPath: 'batch/p1/poster.png',
            originalPath: 'batch/p1/poster.png',
            fileName: 'poster.png',
            fileSizeBytes: 50,
            mimeType: 'image/png',
            packagePath: 'batch/p1',
          },
          {
            uploadKey: 'key2',
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

      const manifest: SelectionManifest = {
        selectedRootName: 'batch',
        fileCount: 2,
        declaredTotalBytes: 200,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'k2',
            normalizedPath: 'batch/2026-project-zebra/project-details.xlsx',
            originalPath: 'batch/2026-project-zebra/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: xlsxBuf.length,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: 'batch/2026-project-zebra',
          },
          {
            uploadKey: 'k1',
            normalizedPath: 'batch/2026-project-alpha/project-details.xlsx',
            originalPath: 'batch/2026-project-alpha/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: xlsxBuf.length,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: 'batch/2026-project-alpha',
          },
        ],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set('k1', xlsxBuf);
      uploads.set('k2', xlsxBuf);

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

  describe('Folder-Shape Detection & Limits', () => {
    it('12. Valid single-project folder', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();

      const manifest: SelectionManifest = {
        selectedRootName: '2026-project-alpha',
        fileCount: 3,
        declaredTotalBytes: xlsxBuf.length + 1000,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'k1',
            normalizedPath: '2026-project-alpha/project-details.xlsx',
            originalPath: '2026-project-alpha/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: xlsxBuf.length,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: '2026-project-alpha',
          },
          {
            uploadKey: 'k2',
            normalizedPath: '2026-project-alpha/poster.png',
            originalPath: '2026-project-alpha/poster.png',
            fileName: 'poster.png',
            fileSizeBytes: 500,
            mimeType: 'image/png',
            packagePath: '2026-project-alpha',
          },
          {
            uploadKey: 'k3',
            normalizedPath: '2026-project-alpha/poster.pdf',
            originalPath: '2026-project-alpha/poster.pdf',
            fileName: 'poster.pdf',
            fileSizeBytes: 500,
            mimeType: 'application/pdf',
            packagePath: '2026-project-alpha',
          },
        ],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set('k1', xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.mode).toBe('single');
      expect(res.batch.packageCount).toBe(1);
      expect(res.batch.invalidPackageCount).toBe(0);
      expect(['valid', 'warning']).toContain(res.batch.packages[0].status);
    });

    it('13. Valid parent folder with multiple projects', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();

      const manifest: SelectionManifest = {
        selectedRootName: 'batch-root',
        fileCount: 4,
        declaredTotalBytes: xlsxBuf.length * 2,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'k1',
            normalizedPath: 'batch-root/p1/project-details.xlsx',
            originalPath: 'batch-root/p1/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: xlsxBuf.length,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: 'batch-root/p1',
          },
          {
            uploadKey: 'k2',
            normalizedPath: 'batch-root/p2/project-details.xlsx',
            originalPath: 'batch-root/p2/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: xlsxBuf.length,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: 'batch-root/p2',
          },
        ],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set('k1', xlsxBuf);
      uploads.set('k2', xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.mode).toBe('batch');
      expect(res.batch.packageCount).toBe(2);
    });

    it('14. Mixed root and child metadata rejection', async () => {
      const manifest: SelectionManifest = {
        selectedRootName: 'root',
        fileCount: 2,
        declaredTotalBytes: 100,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'k1',
            normalizedPath: 'root/project-details.xlsx',
            originalPath: 'root/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: 50,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: 'root',
          },
          {
            uploadKey: 'k2',
            normalizedPath: 'root/child/project-details.xlsx',
            originalPath: 'root/child/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: 50,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: 'root/child',
          },
        ],
      };

      await expect(parseBrowserImportPreview(manifest, new Map())).rejects.toThrow(BrowserImportPreviewLimitError);
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
        descriptors.push({
          uploadKey: `k${i}`,
          normalizedPath: `root/p-${i}/project-details.xlsx`,
          originalPath: `root/p-${i}/project-details.xlsx`,
          fileName: 'project-details.xlsx',
          fileSizeBytes: 10,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          packagePath: `root/p-${i}`,
        });
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
        descriptors.push({
          uploadKey: `k${i}`,
          normalizedPath: `root/p1/file-${i}.txt`,
          originalPath: `root/p1/file-${i}.txt`,
          fileName: `file-${i}.txt`,
          fileSizeBytes: 10,
          mimeType: 'text/plain',
          packagePath: 'root/p1',
        });
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

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 3,
        declaredTotalBytes: xlsxBuf.length + 1000,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'k1',
            normalizedPath: 'solar-monitor/project-details.xlsx',
            originalPath: 'solar-monitor/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: xlsxBuf.length,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: 'solar-monitor',
          },
          {
            uploadKey: 'k2',
            normalizedPath: 'solar-monitor/poster.png',
            originalPath: 'solar-monitor/poster.png',
            fileName: 'poster.png',
            fileSizeBytes: 500,
            mimeType: 'image/png',
            packagePath: 'solar-monitor',
          },
          {
            uploadKey: 'k3',
            normalizedPath: 'solar-monitor/poster.pdf',
            originalPath: 'solar-monitor/poster.pdf',
            fileName: 'poster.pdf',
            fileSizeBytes: 500,
            mimeType: 'application/pdf',
            packagePath: 'solar-monitor',
          },
        ],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set('k1', xlsxBuf);

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

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 2,
        declaredTotalBytes: xlsxBuf.length + jsonBuf.length,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'k1',
            normalizedPath: 'solar-monitor/project-details.xlsx',
            originalPath: 'solar-monitor/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: xlsxBuf.length,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: 'solar-monitor',
          },
          {
            uploadKey: 'k2',
            normalizedPath: 'solar-monitor/project.json',
            originalPath: 'solar-monitor/project.json',
            fileName: 'project.json',
            fileSizeBytes: jsonBuf.length,
            mimeType: 'application/json',
            packagePath: 'solar-monitor',
          },
        ],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set('k1', xlsxBuf);
      uploads.set('k2', jsonBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packages[0].status).toBe('invalid');
      expect(res.batch.packages[0].errors[0].code).toBe('PACKAGE_MULTIPLE_METADATA_SOURCES');
    });

    it('23. Missing metadata rejected', async () => {
      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 1,
        declaredTotalBytes: 500,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'k1',
            normalizedPath: 'solar-monitor/poster.png',
            originalPath: 'solar-monitor/poster.png',
            fileName: 'poster.png',
            fileSizeBytes: 500,
            mimeType: 'image/png',
            packagePath: 'solar-monitor',
          },
        ],
      };

      const res = await parseBrowserImportPreview(manifest, new Map());
      expect(res.batch.packages[0].status).toBe('invalid');
      expect(res.batch.packages[0].errors[0].code).toBe('PACKAGE_METADATA_MISSING');
    });

    it('24. Malformed XLSX isolated to one package', async () => {
      const validXlsxBuf = await buildTestWorkbookBuffer();
      const corruptXlsxBuf = Buffer.from('NOT A REAL XLSX');

      const manifest: SelectionManifest = {
        selectedRootName: 'batch',
        fileCount: 4,
        declaredTotalBytes: validXlsxBuf.length + corruptXlsxBuf.length + 1000,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'k1',
            normalizedPath: 'batch/2026-valid-project/project-details.xlsx',
            originalPath: 'batch/2026-valid-project/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: validXlsxBuf.length,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: 'batch/2026-valid-project',
          },
          {
            uploadKey: 'k1-png',
            normalizedPath: 'batch/2026-valid-project/poster.png',
            originalPath: 'batch/2026-valid-project/poster.png',
            fileName: 'poster.png',
            fileSizeBytes: 500,
            mimeType: 'image/png',
            packagePath: 'batch/2026-valid-project',
          },
          {
            uploadKey: 'k1-pdf',
            normalizedPath: 'batch/2026-valid-project/poster.pdf',
            originalPath: 'batch/2026-valid-project/poster.pdf',
            fileName: 'poster.pdf',
            fileSizeBytes: 500,
            mimeType: 'application/pdf',
            packagePath: 'batch/2026-valid-project',
          },
          {
            uploadKey: 'k2',
            normalizedPath: 'batch/2026-corrupt-project/project-details.xlsx',
            originalPath: 'batch/2026-corrupt-project/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: corruptXlsxBuf.length,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: 'batch/2026-corrupt-project',
          },
        ],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set('k1', validXlsxBuf);
      uploads.set('k2', corruptXlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packageCount).toBe(2);

      const validPkg = res.batch.packages.find((p) => p.folderName === '2026-valid-project');
      const corruptPkg = res.batch.packages.find((p) => p.folderName === '2026-corrupt-project');

      expect(validPkg?.status).not.toBe('invalid');
      expect(corruptPkg?.status).toBe('invalid');
      expect(corruptPkg?.errors[0].code).toBe('WORKBOOK_MALFORMED');
    });

    it('26. Invalid folder-derived public ID validation', () => {
      expect(validateFolderDerivedPublicId('2026-project-alpha').valid).toBe(true);
      expect(validateFolderDerivedPublicId('Project Alpha').valid).toBe(false);
      expect(validateFolderDerivedPublicId('project_alpha').valid).toBe(false);
      expect(validateFolderDerivedPublicId('../project').valid).toBe(false);
    });
  });

  describe('Files & Validation', () => {
    it('31. Required poster PNG missing error', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 2,
        declaredTotalBytes: xlsxBuf.length + 500,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'k1',
            normalizedPath: 'solar-monitor/project-details.xlsx',
            originalPath: 'solar-monitor/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: xlsxBuf.length,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: 'solar-monitor',
          },
          {
            uploadKey: 'k2',
            normalizedPath: 'solar-monitor/poster.pdf',
            originalPath: 'solar-monitor/poster.pdf',
            fileName: 'poster.pdf',
            fileSizeBytes: 500,
            mimeType: 'application/pdf',
            packagePath: 'solar-monitor',
          },
        ],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set('k1', xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packages[0].status).toBe('invalid');
      expect(res.batch.packages[0].errors.some((e) => e.code === 'FILE_MISSING_POSTER_IMAGE')).toBe(true);
    });

    it('36. MIME conflict warning', () => {
      const derived = deriveMimeType('poster.png', 'text/plain');
      expect(derived.mimeType).toBe('image/png');
      expect(derived.warning).toBeDefined();
    });

    it('38. Case-collision duplicate rejected', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 3,
        declaredTotalBytes: xlsxBuf.length + 1000,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'k1',
            normalizedPath: 'solar-monitor/project-details.xlsx',
            originalPath: 'solar-monitor/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: xlsxBuf.length,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: 'solar-monitor',
          },
          {
            uploadKey: 'k2',
            normalizedPath: 'solar-monitor/poster.png',
            originalPath: 'solar-monitor/poster.png',
            fileName: 'poster.png',
            fileSizeBytes: 500,
            mimeType: 'image/png',
            packagePath: 'solar-monitor',
          },
          {
            uploadKey: 'k3',
            normalizedPath: 'solar-monitor/Poster.PNG',
            originalPath: 'solar-monitor/Poster.PNG',
            fileName: 'Poster.PNG',
            fileSizeBytes: 500,
            mimeType: 'image/png',
            packagePath: 'solar-monitor',
          },
        ],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set('k1', xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      expect(res.batch.packages[0].errors.some((e) => e.code === 'PACKAGE_DUPLICATE_CASE_FILE')).toBe(true);
    });

    it('39. Unknown package file warning', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 2,
        declaredTotalBytes: xlsxBuf.length + 500,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'k1',
            normalizedPath: 'solar-monitor/project-details.xlsx',
            originalPath: 'solar-monitor/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: xlsxBuf.length,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: 'solar-monitor',
          },
          {
            uploadKey: 'k2',
            normalizedPath: 'solar-monitor/unknown-notes.txt',
            originalPath: 'solar-monitor/unknown-notes.txt',
            fileName: 'unknown-notes.txt',
            fileSizeBytes: 500,
            mimeType: 'text/plain',
            packagePath: 'solar-monitor',
          },
        ],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set('k1', xlsxBuf);

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
  });

  describe('Privacy & Response Contract', () => {
    it('47. Response contains no Buffer, ArrayBuffer, or binary content', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer();

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 1,
        declaredTotalBytes: xlsxBuf.length,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'k1',
            normalizedPath: 'solar-monitor/project-details.xlsx',
            originalPath: 'solar-monitor/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: xlsxBuf.length,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: 'solar-monitor',
          },
        ],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set('k1', xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      const jsonStr = JSON.stringify(res);

      expect(jsonStr).not.toContain('Buffer');
      expect(jsonStr).not.toContain('ArrayBuffer');
    });

    it('48. Response excludes full team-member roster names', async () => {
      const xlsxBuf = await buildTestWorkbookBuffer({ teamMembers: 'Secret Name One\nSecret Name Two' });

      const manifest: SelectionManifest = {
        selectedRootName: 'solar-monitor',
        fileCount: 1,
        declaredTotalBytes: xlsxBuf.length,
        ignoredSystemFilesCount: 0,
        descriptors: [
          {
            uploadKey: 'k1',
            normalizedPath: 'solar-monitor/project-details.xlsx',
            originalPath: 'solar-monitor/project-details.xlsx',
            fileName: 'project-details.xlsx',
            fileSizeBytes: xlsxBuf.length,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            packagePath: 'solar-monitor',
          },
        ],
      };

      const uploads = new Map<string, Buffer>();
      uploads.set('k1', xlsxBuf);

      const res = await parseBrowserImportPreview(manifest, uploads);
      const jsonStr = JSON.stringify(res);

      expect(jsonStr).not.toContain('Secret Name One');
      expect(jsonStr).not.toContain('Secret Name Two');
      expect(res.batch.packages[0].previewMetadata?.teamMemberCount).toBe(2);
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
