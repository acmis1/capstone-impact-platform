import { Project } from '../domain/project';

export function createMockProject(overrides: Partial<Project> = {}): Project {
  const defaultProject: Project = {
    id: 12345,
    publicId: '2026-mock-project',
    title: 'Automated Wind Farm Site Optimizer',
    summary: 'A clean energy optimization tool for wind turbines.',
    background: 'Wind turbine placements are historically configured using manual site assessment, leading to output inefficiencies.',
    solution: 'This tool automates turbines placements coordinates using fluid dynamics simulation models to improve energy yield.',
    year: '2026',
    program: 'Bachelor of Software Engineering',
    studyProgram: 'Bachelor of Software Engineering',
    discipline: 'Software Engineering',
    disciplines: ['Software Engineering', 'Environmental Science'],
    industry: 'Clean Energy',
    industryPartner: 'EcoPower Global',
    academicSupervisor: 'Dr. John Doe',
    groupName: 'WindForce Twin Tech',
    teamMembers: ['Jane Smith', 'Alice Johnson'],
    poster: 'https://example.com/assets/poster.png',
    posterPdf: 'https://example.com/assets/poster.pdf',
    posterText: 'This poster illustrates fluid dynamics simulation models on clean energy turbine placements.',
    accessibilityText: 'Visual mockup showing 3D layout of turbine structures.',
    snapshots: [
      'https://example.com/assets/snap1.png',
      'https://example.com/assets/snap2.png'
    ],
    videoUrl: 'https://www.youtube.com/watch?v=mockvideo',
    demoUrl: 'https://example.com/demo',
    repositoryUrl: 'https://github.com/example/mock-repo',
    externalLinks: [
      { label: 'Documentation', url: 'https://example.com/docs' }
    ],
    citations: ['Simulation Studies in Energy Vol 12'],
    layoutConfig: {
      templateId: 'poster_showcase',
      featuredMedia: 'poster',
      sectionOrder: ['background', 'solution', 'snapshots', 'video', 'links'],
      hiddenSections: []
    },
    status: 'approved',
    importBatchId: 'batch-2026-06-01-a',
    sourceFolder: 'packages/project-1',
    internalStaffNotes: 'Internal admin notes - please verify ocr output.',
    privateReviewComments: 'Checked supervisor credentials.',
    validationFlags: {
      hasErrors: false,
      hasWarnings: false,
      missingAccessibility: false,
      missingSnapshots: false,
      hasVideo: true,
      hasAudio: false,
      hasModel3d: false
    },
    validationErrors: [],
    validationWarnings: [],
    pendingRemovalFromPublic: false,
    publicRemovalCompletedAt: undefined,
    archivedAt: undefined,
    archivedFromStatus: undefined,
    archiveReason: undefined,
    created_at: '2026-06-01T12:00:00.000Z',
    updated_at: '2026-06-01T12:00:00.000Z'
  };

  return {
    ...defaultProject,
    ...overrides,
    layoutConfig: {
      ...defaultProject.layoutConfig,
      ...(overrides.layoutConfig || {})
    },
    validationFlags: {
      ...defaultProject.validationFlags,
      ...(overrides.validationFlags || {})
    }
  } as Project;
}
