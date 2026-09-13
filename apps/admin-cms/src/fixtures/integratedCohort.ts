import { createHash } from 'node:crypto';

import type { Project } from '../domain/project';
import { formIntakeMetadataSchema, type FormIntakeMetadata } from '../import/formIntakeContract';
import { materializeFormIntakeWorkbook } from '../import/formIntakeWorkbookMaterializer';
import {
  createSyntheticAdminReferenceOptions,
  createSyntheticWorkbookBuffer,
  materializeSyntheticImportBatch,
  type SyntheticAdminReferenceOptions,
  type SyntheticImportMaterializationFile,
  type SyntheticImportMaterializedBatch,
} from './syntheticImportPackages';

export const INTEGRATED_COHORT_SIZE = 120 as const;
export const INTEGRATED_PACKAGE_COUNT = 100 as const;
export const INTEGRATED_FORM_COUNT = 20 as const;
export const INTEGRATED_BATCH_SIZE = 24 as const;

export const INTEGRATED_PROGRAMS = [
  'Synthetic IT Family',
  'Synthetic Engineering Family',
  'Synthetic Aviation Family',
  'Synthetic Food Technology Family',
  'Synthetic Future Systems Program',
] as const;
export const INTEGRATED_DISCIPLINES = [
  'Synthetic Software Engineering',
  'Synthetic Mechanical Engineering',
  'Synthetic Aviation Systems',
  'Synthetic Food Process Engineering',
  'Synthetic Future Systems',
] as const;
export const INTEGRATED_INDUSTRIES = [
  'Synthetic Technology',
  'Synthetic Manufacturing',
  'Synthetic Aviation',
  'Synthetic Food Industry',
  'Synthetic Civic Services',
] as const;

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_PREFIX = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n', 'ascii');
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type IntegratedIntakeMode = 'package' | 'form';

export interface IntegratedCohortManifestEntry {
  caseId: string;
  publicId: string;
  intakeMode: IntegratedIntakeMode;
  batchId: string;
  packagePath: string;
  program: string;
  year: string;
  discipline: string;
  industry: string;
  layoutPreset: 'poster_showcase' | 'technical_detail' | 'media_rich';
  expectedMediaRoles: string[];
  contentDigest: string;
  mediaDigest: string;
  accessibilityMode: 'poster-and-text-bearing-gallery';
}

export interface IntegratedCohortManifest {
  version: 'lv-01-integrated-cohort-v1';
  entries: IntegratedCohortManifestEntry[];
  digest: string;
}

export interface IntegratedCohortPackage {
  entry: IntegratedCohortManifestEntry;
  project: Project;
  mediaFiles: SyntheticImportMaterializationFile[];
}

export interface IntegratedCohortBatch {
  batchId: string;
  entries: IntegratedCohortPackage[];
  materialized: SyntheticImportMaterializedBatch;
}

export interface IntegratedCohortFixture {
  manifest: IntegratedCohortManifest;
  batches: IntegratedCohortBatch[];
  packages: IntegratedCohortPackage[];
  adminReference: SyntheticAdminReferenceOptions;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function mediaBytes(index: number): SyntheticImportMaterializationFile[] {
  const serial = Buffer.from(String(index + 1).padStart(3, '0'), 'ascii');
  return [
    { fileName: 'poster.png', browserMimeType: 'image/png', content: Buffer.concat([PNG_HEADER, serial]) },
    { fileName: 'poster.pdf', browserMimeType: 'application/pdf', content: Buffer.concat([PDF_PREFIX, serial, Buffer.from('\n%%EOF', 'ascii')]) },
    { fileName: 'snapshot-1.png', browserMimeType: 'image/png', content: Buffer.concat([PNG_HEADER, Buffer.from('ordinary-', 'ascii'), serial]) },
    { fileName: 'snapshot-2.png', browserMimeType: 'image/png', content: Buffer.concat([PNG_HEADER, Buffer.from('text-', 'ascii'), serial]) },
  ];
}

function projectFor(index: number, publicId: string): Project {
  const serial = String(index + 1).padStart(3, '0');
  const program = INTEGRATED_PROGRAMS[index % INTEGRATED_PROGRAMS.length];
  const discipline = INTEGRATED_DISCIPLINES[index % INTEGRATED_DISCIPLINES.length];
  const industry = INTEGRATED_INDUSTRIES[Math.floor(index / INTEGRATED_PROGRAMS.length) % INTEGRATED_INDUSTRIES.length];
  const year = String(2022 + (index % 5));
  const templateId = (['poster_showcase', 'technical_detail', 'media_rich'] as const)[index % 3];
  return {
    id: Number(`26${serial}`),
    publicId,
    title: `Synthetic Integrated Project ${serial}`,
    summary: `Synthetic integrated cohort summary ${serial}.`,
    background: `Synthetic integrated cohort background ${serial}.`,
    solution: `Synthetic integrated cohort solution ${serial}.`,
    year,
    program,
    studyProgram: program,
    discipline,
    disciplines: [discipline],
    industry,
    industryPartner: `Synthetic Integrated Partner ${serial}`,
    academicSupervisor: `Synthetic Integrated Supervisor ${serial}`,
    groupName: `Synthetic Integrated Team ${serial}`,
    participantContactEmail: `lv01-${serial}@capstone.invalid`,
    teamMembers: [`Synthetic Participant ${serial}A`, `Synthetic Participant ${serial}B`],
    poster: '',
    posterPdf: '',
    posterText: `Selectable synthetic poster full text for integrated project ${serial}.`,
    accessibilityText: `Accessible synthetic poster description for integrated project ${serial}.`,
    snapshots: [],
    snapshotMedia: [],
    videoUrl: index % 6 === 0 ? `https://video.example.invalid/lv01-${serial}.mp4` : '',
    demoUrl: `https://demo.example.invalid/lv01-${serial}`,
    repositoryUrl: `https://code.example.invalid/lv01-${serial}`,
    externalLinks: [],
    citations: [],
    layoutConfig: {
      templateId,
      featuredMedia: templateId === 'technical_detail' ? 'snapshots' : 'poster',
      sectionOrder: ['background', 'solution', 'snapshots', 'links'],
    },
    status: 'draft',
  };
}

function workbookFields(project: Project, index: number): Record<string, string> {
  const serial = String(index + 1).padStart(3, '0');
  return {
    participantContactEmail: project.participantContactEmail,
    snapshotAltText: `Ordinary gallery image for integrated project ${serial}.`,
    snapshot1ContentKind: 'ordinary',
    snapshot1FullText: '',
    snapshot2AltText: `Text-bearing gallery image for integrated project ${serial}.`,
    snapshot2ContentKind: 'text_bearing',
    snapshot2FullText: `Searchable gallery full text marker LV01-GALLERY-${serial}.`,
  };
}

function formMetadata(project: Project, index: number): FormIntakeMetadata {
  const fields = workbookFields(project, index);
  return {
    publicId: project.publicId!, title: project.title, summary: project.summary,
    background: project.background, solution: project.solution,
    teamMembers: project.teamMembers.join('\n'), groupName: project.groupName,
    participantContactEmail: project.participantContactEmail,
    academicSupervisor: project.academicSupervisor, industryPartner: project.industryPartner,
    industry: project.industry, program: project.program, discipline: project.discipline,
    year: project.year, templateId: project.layoutConfig.templateId,
    featuredMedia: project.layoutConfig.featuredMedia, posterText: project.posterText,
    accessibilityText: project.accessibilityText, videoUrl: project.videoUrl,
    demoUrl: project.demoUrl, repositoryUrl: project.repositoryUrl,
    ...fields,
  };
}

export function assertExactIdentitySet(expected: readonly string[], actual: readonly string[], stage: string): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (expected.length !== expectedSet.size) throw new Error(`LV01_${stage}_EXPECTED_DUPLICATE_IDENTITY`);
  if (actual.length !== actualSet.size) throw new Error(`LV01_${stage}_ACTUAL_DUPLICATE_IDENTITY`);
  if (expectedSet.size !== actualSet.size
    || [...expectedSet].some((publicId) => !actualSet.has(publicId))
    || [...actualSet].some((publicId) => !expectedSet.has(publicId))) {
    throw new Error(`LV01_${stage}_IDENTITY_SET_MISMATCH`);
  }
}

export async function buildIntegratedCohortFixture(): Promise<IntegratedCohortFixture> {
  const packages: IntegratedCohortPackage[] = [];
  const materializationInputs: Array<{
    publicId: string; packagePath: string; metadataFileName: 'project-details.xlsx';
    metadataBuffer: Buffer; mediaFiles: SyntheticImportMaterializationFile[];
  }> = [];

  for (let index = 0; index < INTEGRATED_COHORT_SIZE; index += 1) {
    const caseId = `lv01-case-${String(index + 1).padStart(3, '0')}`;
    const publicId = `lv01-integrated-${String(index + 1).padStart(3, '0')}`;
    const batchId = `lv01-integrated-batch-${String(Math.floor(index / INTEGRATED_BATCH_SIZE) + 1).padStart(2, '0')}`;
    const packagePath = `${batchId}/${publicId}`;
    const intakeMode: IntegratedIntakeMode = index < INTEGRATED_PACKAGE_COUNT ? 'package' : 'form';
    const project = projectFor(index, publicId);
    const fields = workbookFields(project, index);
    const metadataBuffer = intakeMode === 'form'
      ? await materializeFormIntakeWorkbook(formIntakeMetadataSchema.parse(formMetadata(project, index)))
      : await createSyntheticWorkbookBuffer(project, fields);
    const mediaFiles = mediaBytes(index);
    const contentDigest = sha256(canonicalJson({
      publicId, title: project.title, summary: project.summary, background: project.background,
      solution: project.solution, year: project.year, program: project.program,
      discipline: project.discipline, industry: project.industry, layoutConfig: project.layoutConfig,
      posterText: project.posterText, accessibilityText: project.accessibilityText, ...fields,
    }));
    const mediaDigest = sha256(canonicalJson(mediaFiles.map((file) => ({
      fileName: file.fileName, mimeType: file.browserMimeType, sha256: sha256(file.content),
    }))));
    const entry: IntegratedCohortManifestEntry = {
      caseId, publicId, intakeMode, batchId, packagePath,
      program: project.program, year: project.year, discipline: project.discipline,
      industry: project.industry,
      layoutPreset: project.layoutConfig.templateId as IntegratedCohortManifestEntry['layoutPreset'],
      expectedMediaRoles: ['poster_image', 'poster_pdf', 'snapshot:1:ordinary', 'snapshot:2:text_bearing'],
      contentDigest, mediaDigest, accessibilityMode: 'poster-and-text-bearing-gallery',
    };
    packages.push({ entry, project, mediaFiles });
    materializationInputs.push({ publicId, packagePath, metadataFileName: 'project-details.xlsx', metadataBuffer, mediaFiles });
  }

  const entries = packages.map((item) => item.entry);
  const manifestBody = { version: 'lv-01-integrated-cohort-v1' as const, entries };
  const manifest: IntegratedCohortManifest = Object.freeze({
    ...manifestBody,
    entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))) as unknown as IntegratedCohortManifestEntry[],
    digest: sha256(canonicalJson(manifestBody)),
  });
  assertExactIdentitySet(entries.map((entry) => entry.publicId), packages.map((item) => item.project.publicId!), 'MANIFEST');

  const batches: IntegratedCohortBatch[] = [];
  for (let offset = 0; offset < packages.length; offset += INTEGRATED_BATCH_SIZE) {
    const batchPackages = packages.slice(offset, offset + INTEGRATED_BATCH_SIZE);
    const batchId = batchPackages[0].entry.batchId;
    batches.push({
      batchId,
      entries: batchPackages,
      materialized: materializeSyntheticImportBatch(batchId, materializationInputs.slice(offset, offset + INTEGRATED_BATCH_SIZE)),
    });
  }
  const adminReference = await createSyntheticAdminReferenceOptions(packages.map((item) => item.project));
  return { manifest, batches, packages, adminReference };
}

export const INTEGRATED_XLSX_MIME_TYPE = XLSX_MIME;
