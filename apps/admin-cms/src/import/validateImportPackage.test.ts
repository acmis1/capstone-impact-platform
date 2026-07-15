import { describe, it, expect } from 'vitest';
import { validateImportPackage } from './validateImportPackage';
import { ImportPackageParseResult, ImportPackageManifest } from './importTypes';

function createMockParsedPackage(overrides: Partial<ImportPackageParseResult> = {}, manifestOverrides: Partial<ImportPackageManifest> = {}): ImportPackageParseResult {
  const defaultManifest: ImportPackageManifest = {
    publicId: '2026-optimizer',
    title: 'Wind Optimizer',
    summary: 'Optimizes wind turbines placements',
    background: 'Wind turbine background assessment',
    solution: 'Fluid dynamics modeling solution',
    year: '2026',
    program: 'Software Engineering',
    studyProgram: 'Software Engineering',
    discipline: 'Software Engineering',
    industry: 'Energy',
    industryPartner: 'WindCorp',
    academicSupervisor: 'Dr. Jane Wind',
    groupName: 'Wind Team',
    teamMembers: ['Alice', 'Bob'],
    accessibilityText: 'Alternative text describing the layout.',
    posterText: 'Poster text about wind turbines.',
    layoutConfig: {
      templateId: 'poster_showcase',
      featuredMedia: 'poster',
      sectionOrder: ['background', 'solution'],
    },
  };

  const defaultPackage: ImportPackageParseResult = {
    manifest: {
      ...defaultManifest,
      ...manifestOverrides,
    },
    posterImage: {
      fileName: 'poster.png',
      fileSizeBytes: 1024 * 1024,
      mimeType: 'image/png',
      content: Buffer.from([]),
    },
    posterPdf: {
      fileName: 'poster.pdf',
      fileSizeBytes: 2 * 1024 * 1024,
      mimeType: 'application/pdf',
      content: Buffer.from([]),
    },
    snapshot1: {
      fileName: 'snapshot-1.png',
      fileSizeBytes: 500 * 1024,
      mimeType: 'image/png',
      content: Buffer.from([]),
    },
  };

  return {
    ...defaultPackage,
    ...overrides,
  };
}

describe('validateImportPackage', () => {
  it('passes validation for a complete safe package', () => {
    const pkg = createMockParsedPackage();
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('fails validation when required manifest fields are missing', () => {
    const pkg = createMockParsedPackage({}, { title: '' });
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.ruleCode === 'METADATA_MISSING_TITLE')).toBe(true);
  });

  it('fails validation when teamMembers list is empty', () => {
    const pkg = createMockParsedPackage({}, { teamMembers: [] });
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.ruleCode === 'METADATA_EMPTY_ROSTER')).toBe(true);
  });

  it('fails validation when layoutConfig is missing', () => {
    const pkg = createMockParsedPackage();
    (pkg.manifest as unknown as Record<string, unknown>).layoutConfig = null;
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.ruleCode === 'METADATA_INVALID_LAYOUT')).toBe(true);
  });

  it('fails validation when poster.png is missing', () => {
    const pkg = createMockParsedPackage({ posterImage: null });
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.ruleCode === 'FILE_MISSING_POSTER_IMAGE')).toBe(true);
  });

  it('fails validation when poster.pdf is missing', () => {
    const pkg = createMockParsedPackage({ posterPdf: null });
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.ruleCode === 'FILE_MISSING_POSTER_PDF')).toBe(true);
  });

  it('produces a warning when recommended snapshot is missing', () => {
    const pkg = createMockParsedPackage({ snapshot1: null });
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.ruleCode === 'FILE_MISSING_RECOMMENDED')).toBe(true);
  });

  it('produces a warning when accessibilityText is missing', () => {
    const pkg = createMockParsedPackage({}, { accessibilityText: '' });
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.ruleCode === 'RECOMMENDED_FIELD_MISSING' && w.fieldName === 'accessibilityText')).toBe(true);
  });

  it('produces a warning when posterText is missing', () => {
    const pkg = createMockParsedPackage({}, { posterText: '' });
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.ruleCode === 'RECOMMENDED_FIELD_MISSING' && w.fieldName === 'posterText')).toBe(true);
  });

  it('propagates media validation errors (like invalid type or size)', () => {
    const pkg = createMockParsedPackage({
      posterImage: {
        fileName: 'poster.png',
        fileSizeBytes: 6 * 1024 * 1024, // 6 MB (Max 5MB)
        mimeType: 'image/png',
        content: Buffer.from([]),
      },
    });

    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.ruleCode === 'FILE_INVALID_POSTER_IMAGE')).toBe(true);
  });

  it('does not mutate the input package object', () => {
    const pkg = createMockParsedPackage();
    const originalJson = JSON.stringify(pkg);
    validateImportPackage(pkg);
    expect(JSON.stringify(pkg)).toBe(originalJson);
  });
});
