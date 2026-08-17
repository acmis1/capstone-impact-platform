import { Project, ValidationFlagRecord } from '../domain/project';
import { WORKFLOW_STATUSES, WorkflowStatus } from '../domain/workflowStatus';
import { isSafeExternalPreviewUrl } from '../previews/participantPreviewHtml';
import { PROJECT_METADATA_LIMITS, projectMetadataInputSchema } from '../projects/projectMetadata';
import { validateMediaAsset } from '../storage/mediaValidationCore';
import { validateProjectForApproval } from '../validation/projectValidation';

const COMPLETE_PRIVATE_APPROVAL_MEDIA = {
  posterImage: { rowCount: 1, validPrivateCount: 1 },
  posterPdf: { rowCount: 1, validPrivateCount: 1 },
  snapshotMedia: null,
};

export const DEFAULT_SYNTHETIC_SEED = 0xD4072026;
export const SYNTHETIC_PROJECT_COUNTS = [100, 500, 1000] as const;
export type SyntheticProjectCount = (typeof SYNTHETIC_PROJECT_COUNTS)[number];

const SYNTHETIC_YEARS = ['2022', '2023', '2024', '2025', '2026'] as const;
const SYNTHETIC_PROGRAMS = [
  'Synthetic Software Systems',
  'Synthetic Engineering Design',
  'Synthetic Data Practice',
  'Synthetic Digital Experience',
] as const;
const SYNTHETIC_DISCIPLINES = [
  'Synthetic Software Engineering',
  'Synthetic Mechanical Design',
  'Synthetic Data Systems',
  'Synthetic Digital Media',
  'Synthetic Network Practice',
] as const;
const SYNTHETIC_INDUSTRIES = [
  'Synthetic Technology',
  'Synthetic Health Systems',
  'Synthetic Agriculture',
  'Synthetic Climate Services',
  'Synthetic Civic Infrastructure',
] as const;

export const SYNTHETIC_WORKFLOW_STATUSES = WORKFLOW_STATUSES.filter(
  (status): status is Exclude<WorkflowStatus, 'deleted'> => status !== 'deleted',
);

const SYNTHETIC_TITLE_SUBJECTS = [
  'Signal',
  'Archive',
  'Pattern',
  'Orbit',
  'Garden',
  'Transit',
] as const;
const SYNTHETIC_TITLE_ACTIONS = [
  'Mapping',
  'Planning',
  'Monitoring',
  'Routing',
  'Modelling',
  'Indexing',
] as const;

type SeededRandom = () => number;

function createSeededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function createRotations(seed: number, lengths: number[]): number[] {
  const random = createSeededRandom(seed);
  return lengths.map((length) => Math.floor(random() * length));
}

function pickRotated<T>(values: readonly T[], index: number, rotation: number): T {
  return values[(index + rotation) % values.length];
}

function paddedIndex(index: number): string {
  return String(index + 1).padStart(4, '0');
}

function createAssetUrl(publicId: string, fileName: string): string {
  return `https://assets.synthetic.invalid/${publicId}/${fileName}`;
}

export function createValidationFlags(index: number): ValidationFlagRecord {
  switch (index % 4) {
    case 0:
      return {
        hasErrors: false,
        hasWarnings: false,
        missingAccessibility: false,
        missingSnapshots: false,
        hasVideo: false,
        hasAudio: false,
        hasModel3d: false,
      };
    case 1:
      return {
        hasErrors: false,
        hasWarnings: true,
        missingAccessibility: true,
        missingSnapshots: false,
        hasVideo: true,
        hasAudio: false,
        hasModel3d: false,
      };
    case 2:
      return {
        hasErrors: true,
        hasWarnings: true,
        missingAccessibility: false,
        missingSnapshots: true,
        hasVideo: false,
        hasAudio: false,
        hasModel3d: false,
      };
    default:
      return {
        hasErrors: false,
        hasWarnings: false,
        missingAccessibility: false,
        missingSnapshots: false,
        hasVideo: true,
        hasAudio: true,
        hasModel3d: true,
      };
  }
}

/** Deterministic synthetic description, paired with its URL so the two can never drift apart. */
function createSyntheticSnapshotMedia(publicId: string, urls: string[]): Project['snapshotMedia'] {
  return urls.map((url, position) => ({
    url,
    altText: `Synthetic snapshot ${position + 1} for ${publicId}: a generated placeholder image used for repeatable local checks.`,
  }));
}

function createOptionalMedia(index: number, publicId: string): Pick<
  Project,
  'snapshots' | 'snapshotMedia' | 'videoUrl' | 'demoUrl' | 'repositoryUrl' | 'externalLinks'
> {
  const posterUrl = createAssetUrl(publicId, 'snapshot-01.png');

  switch (index % 4) {
    case 0: {
      const snapshots = [posterUrl, createAssetUrl(publicId, 'snapshot-02.png')];
      return {
        snapshots,
        snapshotMedia: createSyntheticSnapshotMedia(publicId, snapshots),
        videoUrl: `https://video.synthetic.invalid/${publicId}`,
        demoUrl: `https://demo.synthetic.invalid/${publicId}`,
        repositoryUrl: `https://code.synthetic.invalid/${publicId}`,
        externalLinks: [{ label: 'Synthetic reference', url: `https://links.synthetic.invalid/${publicId}` }],
      };
    }
    case 1:
      return {
        snapshots: [posterUrl],
        snapshotMedia: createSyntheticSnapshotMedia(publicId, [posterUrl]),
        videoUrl: '',
        demoUrl: '',
        repositoryUrl: '',
        externalLinks: [],
      };
    case 2:
      return {
        snapshots: [],
        snapshotMedia: [],
        videoUrl: '',
        demoUrl: '',
        repositoryUrl: '',
        externalLinks: [],
      };
    default:
      return {
        snapshots: [],
        snapshotMedia: [],
        videoUrl: `https://video.synthetic.invalid/${publicId}`,
        demoUrl: '',
        repositoryUrl: '',
        externalLinks: [],
      };
  }
}

function createSyntheticProject(
  index: number,
  rotations: number[],
): Project {
  const year = pickRotated(SYNTHETIC_YEARS, index, rotations[0]);
  const program = pickRotated(SYNTHETIC_PROGRAMS, index, rotations[1]);
  const discipline = pickRotated(SYNTHETIC_DISCIPLINES, index, rotations[2]);
  const industry = pickRotated(SYNTHETIC_INDUSTRIES, index, rotations[3]);
  const status = pickRotated(SYNTHETIC_WORKFLOW_STATUSES, index, rotations[4]);
  const sequence = paddedIndex(index);
  const publicId = `synthetic-${year}-${sequence}`;
  const teamSize = (index % 5) + 1;
  const createdAt = new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString();
  const optionalMedia = createOptionalMedia(index, publicId);
  const titleSubject = pickRotated(SYNTHETIC_TITLE_SUBJECTS, index, rotations[5]);
  const titleAction = pickRotated(SYNTHETIC_TITLE_ACTIONS, index, rotations[6]);

  return {
    id: Number(`${year}${sequence}`),
    publicId,
    title: `Synthetic ${titleSubject} ${titleAction} Project ${sequence}`,
    summary: `Synthetic project ${sequence} demonstrates deterministic ${titleAction.toLowerCase()} for benchmark coverage.`,
    background: `Synthetic background for project ${sequence}; no participant or stakeholder data is represented.`,
    solution: `Synthetic solution for project ${sequence}; generated locally for repeatable repository and feed checks.`,
    year,
    program,
    studyProgram: program,
    discipline,
    disciplines: [discipline, 'Synthetic Cross-Discipline'],
    industry,
    industryPartner: `Synthetic Industry Partner ${sequence}`,
    academicSupervisor: `Synthetic Supervisor ${sequence}`,
    groupName: `Synthetic Team ${sequence}`,
    // Deliberately blank: synthetic benchmark data must contain nothing email-shaped, and these
    // records exist only to exercise indexing and feed volume, never preview correspondence.
    participantContactEmail: '',
    teamMembers: Array.from({ length: teamSize }, (_, memberIndex) =>
      `Synthetic Member ${sequence}-${String(memberIndex + 1).padStart(2, '0')}`,
    ),
    poster: createAssetUrl(publicId, 'poster.png'),
    posterPdf: createAssetUrl(publicId, 'poster.pdf'),
    posterText: `Synthetic poster text for project ${sequence}.`,
    accessibilityText: `Synthetic accessibility description for project ${sequence}.`,
    ...optionalMedia,
    citations: index % 2 === 0 ? [`Synthetic citation ${sequence}`] : [],
    layoutConfig: {
      templateId: (['poster_showcase', 'technical_detail', 'media_rich'] as const)[index % 3],
      featuredMedia: index % 4 === 0 ? 'video' : 'poster',
      sectionOrder: ['background', 'solution', 'snapshots', 'links'],
    },
    status,
    importBatchId: `synthetic-batch-${year}`,
    sourceFolder: `synthetic-project-${sequence}`,
    internalStaffNotes: `Synthetic internal note ${sequence}.`,
    privateReviewComments: `Synthetic review note ${sequence}.`,
    validationFlags: createValidationFlags(index),
    validationErrors: index % 4 === 2 ? [`Synthetic validation error ${sequence}.`] : [],
    validationWarnings: index % 4 === 1 ? [`Synthetic validation warning ${sequence}.`] : [],
    created_at: createdAt,
    updated_at: new Date(Date.UTC(2024, 0, 1, 1, 0, index)).toISOString(),
  };
}

export interface GenerateSyntheticProjectsOptions {
  count: SyntheticProjectCount;
  seed?: number;
}

export function generateSyntheticProjects({ count, seed = DEFAULT_SYNTHETIC_SEED }: GenerateSyntheticProjectsOptions): Project[] {
  if (!SYNTHETIC_PROJECT_COUNTS.includes(count)) {
    throw new Error(`Synthetic project count must be one of: ${SYNTHETIC_PROJECT_COUNTS.join(', ')}.`);
  }

  const rotations = createRotations(seed, [
    SYNTHETIC_YEARS.length,
    SYNTHETIC_PROGRAMS.length,
    SYNTHETIC_DISCIPLINES.length,
    SYNTHETIC_INDUSTRIES.length,
    SYNTHETIC_WORKFLOW_STATUSES.length,
    SYNTHETIC_TITLE_SUBJECTS.length,
    SYNTHETIC_TITLE_ACTIONS.length,
  ]);

  return Array.from({ length: count }, (_, index) => createSyntheticProject(index, rotations));
}

export function findDuplicatePublicIds(projects: Pick<Project, 'publicId'>[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  projects.forEach((project) => {
    if (!project.publicId) return;
    if (seen.has(project.publicId)) duplicates.add(project.publicId);
    seen.add(project.publicId);
  });

  return [...duplicates].sort();
}

export type InvalidSyntheticFixtureKind =
  | 'missing-title'
  | 'missing-year'
  | 'invalid-status'
  | 'duplicate-public-id'
  | 'invalid-url'
  | 'oversized-text'
  | 'unsupported-media-type'
  | 'missing-required-category';

export interface InvalidSyntheticFixture {
  kind: InvalidSyntheticFixtureKind;
  description: string;
  payload: unknown;
}

function createValidMetadataInput() {
  return {
    publicId: 'synthetic-metadata-fixture',
    title: 'Synthetic metadata fixture',
    summary: 'Synthetic metadata summary.',
    background: '',
    solution: '',
    year: '2026',
    programId: '00000000-0000-0000-0000-000000000001',
    disciplineIds: ['00000000-0000-0000-0000-000000000002'],
    industryCategoryIds: ['00000000-0000-0000-0000-000000000003'],
    expectedUpdatedAt: '2024-01-01T00:00:00.000Z',
  };
}

export function createInvalidSyntheticProjectFixtures(): InvalidSyntheticFixture[] {
  const baseProject = generateSyntheticProjects({ count: 100 })[0];
  const duplicateProject = { ...generateSyntheticProjects({ count: 100 })[1], publicId: baseProject.publicId };
  const invalidStatusProject = { ...baseProject, status: 'not-a-workflow-status' };
  const oversizedTextInput = {
    ...createValidMetadataInput(),
    summary: 'x'.repeat(PROJECT_METADATA_LIMITS.summary + 1),
  };
  const missingCategoryInput = {
    ...createValidMetadataInput(),
    industryCategoryIds: [],
  };

  return [
    {
      kind: 'missing-title',
      description: 'Project title is empty at the approval boundary.',
      payload: { ...baseProject, title: '' },
    },
    {
      kind: 'missing-year',
      description: 'Project year is empty at the approval boundary.',
      payload: { ...baseProject, year: '' },
    },
    {
      kind: 'invalid-status',
      description: 'Project status is outside the existing workflow status allowlist.',
      payload: invalidStatusProject,
    },
    {
      kind: 'duplicate-public-id',
      description: 'Two synthetic projects share one public ID.',
      payload: [baseProject, duplicateProject],
    },
    {
      kind: 'invalid-url',
      description: 'External link URL is not a safe absolute HTTP(S) URL.',
      payload: {
        ...baseProject,
        externalLinks: [{ label: 'Invalid synthetic link', url: 'javascript:alert(1)' }],
      },
    },
    {
      kind: 'oversized-text',
      description: 'Metadata summary exceeds the current production limit.',
      payload: oversizedTextInput,
    },
    {
      kind: 'unsupported-media-type',
      description: 'Media MIME type is outside the existing supported set.',
      payload: { fileName: 'synthetic.bin', fileSizeBytes: 128, mimeType: 'application/octet-stream' },
    },
    {
      kind: 'missing-required-category',
      description: 'Metadata has no required industry category selection.',
      payload: missingCategoryInput,
    },
  ];
}

export function validateInvalidSyntheticFixture(fixture: InvalidSyntheticFixture): boolean {
  switch (fixture.kind) {
    case 'missing-title':
    case 'missing-year':
      return !validateProjectForApproval(fixture.payload as Project, COMPLETE_PRIVATE_APPROVAL_MEDIA).valid;
    case 'invalid-status':
      return !WORKFLOW_STATUSES.includes((fixture.payload as { status: string }).status as WorkflowStatus);
    case 'duplicate-public-id':
      return findDuplicatePublicIds(fixture.payload as Pick<Project, 'publicId'>[]).length > 0;
    case 'invalid-url':
      return !isSafeExternalPreviewUrl((fixture.payload as Project).externalLinks[0].url);
    case 'oversized-text':
    case 'missing-required-category':
      return !projectMetadataInputSchema.safeParse(fixture.payload).success;
    case 'unsupported-media-type':
      return !validateMediaAsset(fixture.payload as {
        fileName: string;
        fileSizeBytes: number;
        mimeType: string;
      }).valid;
  }
}
