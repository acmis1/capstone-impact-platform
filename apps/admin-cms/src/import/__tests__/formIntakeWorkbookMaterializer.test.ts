import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { materializeFormIntakeWorkbook } from '../formIntakeWorkbookMaterializer';
import { parseProjectDetailsWorkbook } from '../parseProjectDetailsWorkbook';
import {
  COLUMN_DEFINITIONS,
  PREFERRED_WORKSHEET_NAME,
} from '../projectDetailsWorkbookContract';
import { FormIntakeMetadata, createInitialFormIntakeMetadata } from '../formIntakeContract';

describe('formIntakeWorkbookMaterializer', () => {
  it('generates a valid project-details.xlsx workbook with canonical headers and values', async () => {
    const metadata: FormIntakeMetadata = {
      ...createInitialFormIntakeMetadata(),
      publicId: 'smart-grid-2026',
      title: 'Smart Grid Monitoring',
      summary: 'Automated monitoring of renewable electrical distribution.',
      background: 'Aging infrastructure requires continuous telemetry.',
      solution: 'IoT sensing nodes deployed across grid transformers.',
      teamMembers: 'Alice Smith, Bob Jones',
      groupName: 'Grid Intelligence',
      participantContactEmail: 'contact@grid.test',
      academicSupervisor: 'Dr. Evelyn Clark',
      industryPartner: 'PowerCorp Victoria',
      industry: 'Energy & Utilities',
      program: 'Bachelor of Engineering (Electrical)',
      discipline: 'Electrical Engineering',
      year: '2026',
      templateId: 'technical_detail',
      featuredMedia: 'snapshots',
      posterText: 'Full research transcription for smart grid monitoring.',
      accessibilityText: 'Poster with schematic diagrams of the electrical grid.',
      videoUrl: 'https://youtube.com/watch?v=12345678',
      demoUrl: 'https://demo.grid.test',
      repositoryUrl: 'https://github.com/grid/monitor',
      snapshotAltText: 'Field test deployment photo',
      snapshot1ContentKind: 'ordinary',
      snapshot1FullText: '',
      snapshot2AltText: 'Grid telemetry dashboard screenshot',
      snapshot2ContentKind: 'text_bearing',
      snapshot2FullText: 'Dashboard displays voltage 240V, frequency 50Hz, power factor 0.98.',
    };

    const buffer = await materializeFormIntakeWorkbook(metadata);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);

    // Verify directly with ExcelJS structure
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0]);

    const worksheet = workbook.getWorksheet(PREFERRED_WORKSHEET_NAME);
    expect(worksheet).toBeDefined();

    // Row 1: Headers
    const expectedHeaders = COLUMN_DEFINITIONS.map((def) => def.canonicalName);
    const actualHeaders: string[] = [];
    worksheet!.getRow(1).eachCell((cell) => {
      actualHeaders.push(String(cell.value || ''));
    });
    expect(actualHeaders).toEqual(expectedHeaders);

    // Verify it parses cleanly with production parseProjectDetailsWorkbook
    const parseResult = await parseProjectDetailsWorkbook(buffer);
    expect(parseResult.metadata.title).toBe('Smart Grid Monitoring');
    expect(parseResult.metadata.summary).toBe('Automated monitoring of renewable electrical distribution.');
    expect(parseResult.metadata.year).toBe('2026');
    expect(parseResult.metadata.program).toBe('Bachelor of Engineering (Electrical)');
    expect(parseResult.metadata.discipline).toBe('Electrical Engineering');
    expect(parseResult.metadata.groupName).toBe('Grid Intelligence');
    expect(parseResult.metadata.teamMembers).toEqual(['Alice Smith', 'Bob Jones']);
    expect(parseResult.metadata.posterText).toBe('Full research transcription for smart grid monitoring.');
    expect(parseResult.metadata.accessibilityText).toBe('Poster with schematic diagrams of the electrical grid.');
    expect(parseResult.metadata.videoUrl).toBe('https://youtube.com/watch?v=12345678');
    expect(parseResult.metadata.demoUrl).toBe('https://demo.grid.test/');
    expect(parseResult.metadata.repositoryUrl).toBe('https://github.com/grid/monitor');
    expect(parseResult.metadata.snapshotAltText).toBe('Field test deployment photo');

    // MG-05 gallery text-equivalent verification
    expect(parseResult.metadata.galleryAltTexts).toHaveLength(2);

    const snap1 = parseResult.metadata.galleryAltTexts.find((g) => g.position === 1);
    expect(snap1).toBeDefined();
    expect(snap1?.altText).toBe('Field test deployment photo');
    expect(snap1?.contentKind).toBe('ordinary');
    expect(snap1?.fullText).toBe('');

    const snap2 = parseResult.metadata.galleryAltTexts.find((g) => g.position === 2);
    expect(snap2).toBeDefined();
    expect(snap2?.altText).toBe('Grid telemetry dashboard screenshot');
    expect(snap2?.contentKind).toBe('text_bearing');
    expect(snap2?.fullText).toBe('Dashboard displays voltage 240V, frequency 50Hz, power factor 0.98.');

    // Positions 3-10 must NOT exist in galleryAltTexts because they were not populated
    for (let pos = 3; pos <= 10; pos++) {
      expect(parseResult.metadata.galleryAltTexts.find((g) => g.position === pos)).toBeUndefined();
    }
  });
});
