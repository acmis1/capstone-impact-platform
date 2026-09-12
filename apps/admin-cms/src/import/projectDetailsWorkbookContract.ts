import type { SnapshotImageContentKind } from '../domain/galleryTextEquivalent';

export interface ProjectDetailsWorkbookIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  fieldName?: string;
  columnName?: string;
  rowNumber?: number;
}
/**
 * Everything the project team declares about one gallery position, kept on one object so the
 * alt description, the explicit content classification and the full textual equivalent can never
 * drift apart across independent parallel arrays. `altText` may be an empty string when the
 * classification or full text was supplied without a description; the package-aware boundary
 * reports that as a missing description rather than the parser silently dropping the position.
 */
export interface ProjectDetailsGalleryAltText {
  position: number;
  altText: string;
  /** Explicit project-team classification; null when the cell is blank. Never inferred. */
  contentKind: SnapshotImageContentKind | null;
  /** Full textual equivalent; empty string when the cell is blank. */
  fullText: string;
}

export type GalleryAltTextInternalField =
  | 'snapshot2AltText'
  | 'snapshot3AltText'
  | 'snapshot4AltText'
  | 'snapshot5AltText'
  | 'snapshot6AltText'
  | 'snapshot7AltText'
  | 'snapshot8AltText'
  | 'snapshot9AltText'
  | 'snapshot10AltText';

/** Per-position "content type" and "full text" columns, positions 1 through 10. */
export type GalleryTextEquivalentInternalField =
  | 'snapshot1ContentKind'
  | 'snapshot2ContentKind'
  | 'snapshot3ContentKind'
  | 'snapshot4ContentKind'
  | 'snapshot5ContentKind'
  | 'snapshot6ContentKind'
  | 'snapshot7ContentKind'
  | 'snapshot8ContentKind'
  | 'snapshot9ContentKind'
  | 'snapshot10ContentKind'
  | 'snapshot1FullText'
  | 'snapshot2FullText'
  | 'snapshot3FullText'
  | 'snapshot4FullText'
  | 'snapshot5FullText'
  | 'snapshot6FullText'
  | 'snapshot7FullText'
  | 'snapshot8FullText'
  | 'snapshot9FullText'
  | 'snapshot10FullText';

export interface ProjectDetailsWorkbookMetadata {
  title: string;
  summary: string;
  background: string;
  solution: string;
  teamMembers: string[];
  groupName: string;
  /**
   * Authoritative participant/group contact address used for participant preview correspondence.
   * Normalized to trimmed lowercase, or empty when the staff-facing column is left blank.
   */
  participantContactEmail: string;
  academicSupervisor: string;
  industryPartner: string;
  industry: string;
  program: string;
  studyProgram: string;
  discipline: string;
  year: string;
  videoUrl: string;
  demoUrl: string;
  repositoryUrl: string;
  /**
   * Searchable/selectable full textual version of the meaningful poster content. Required: the
   * public project page must carry a full text version of its image content.
   */
  posterText: string;
  /** Concise descriptive text alternative/context for the poster image. Required. */
  accessibilityText: string;
  /**
   * Project-team-authored text alternative describing the meaningful content of `snapshot-1.png`.
   *
   * Conditionally required, and therefore not a required *column*: the workbook parser cannot see
   * which files the package contains, so it only enforces the rules it can evaluate on its own
   * (readable cell, bounded length). Whether a blank value is acceptable is decided at the
   * package-aware boundary, which knows whether `snapshot-1.png` is actually present.
   *
   * Empty string means "absent column or blank cell". Nothing derives this value from the filename,
   * the project title, the poster accessibility text, OCR, or AI.
   */
  snapshotAltText: string;
  galleryAltTexts: ProjectDetailsGalleryAltText[];
  layoutConfig: {
    templateId: string;
    featuredMedia: string;
    sectionOrder: string[];
    hiddenSections: string[];
  };
}

export interface ProjectDetailsWorkbookParseResult {
  metadata: ProjectDetailsWorkbookMetadata;
  warnings: ProjectDetailsWorkbookIssue[];
  source: {
    sheetName: string;
    headerRowNumber: number;
    projectRowNumber: number;
  };
}

export class ProjectDetailsWorkbookError extends Error {
  public readonly issues: ProjectDetailsWorkbookIssue[];
  public readonly errors: ProjectDetailsWorkbookIssue[];
  public readonly warnings: ProjectDetailsWorkbookIssue[];

  constructor(message: string, issues: ProjectDetailsWorkbookIssue[]) {
    super(message);
    this.name = 'ProjectDetailsWorkbookError';
    this.issues = issues;
    this.errors = issues.filter(i => i.severity === 'error');
    this.warnings = issues.filter(i => i.severity === 'warning');
  }
}

export const PREFERRED_WORKSHEET_NAME = 'Project details';

export const DEFAULT_LAYOUT_CONFIG = {
  templateId: 'poster_showcase',
  featuredMedia: 'poster',
  sectionOrder: ['background', 'solution', 'snapshots', 'video', 'links'],
  hiddenSections: []
} as const;

export function normalizeOptionString(str: string): string {
  return str
    .trim()
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const SHOWCASE_LAYOUT_MAPPINGS: Record<string, string> = {
  'poster showcase': 'poster_showcase',
  'poster first showcase': 'poster_showcase',
  'poster': 'poster_showcase',
  'technical report': 'technical_detail',
  'report first layout': 'technical_detail',
  'technical detail': 'technical_detail',
  'media rich showcase': 'media_rich',
  'media rich': 'media_rich',
  'video and gallery showcase': 'media_rich'
};

export const FEATURED_MEDIA_MAPPINGS: Record<string, string> = {
  'auto': 'auto',
  'poster': 'poster',
  'gallery': 'snapshots',
  'snapshots': 'snapshots',
  'video': 'video'
};

export function normalizeShowcaseLayout(input: string): string | null {
  const norm = normalizeOptionString(input);
  return SHOWCASE_LAYOUT_MAPPINGS[norm] ?? null;
}

export function normalizeFeaturedMedia(input: string): string | null {
  const norm = normalizeOptionString(input);
  return FEATURED_MEDIA_MAPPINGS[norm] ?? null;
}

export interface ColumnDefinition {
  canonicalName: string;
  internalField:
    | keyof ProjectDetailsWorkbookMetadata
    | GalleryAltTextInternalField
    | GalleryTextEquivalentInternalField
    | 'templateId'
    | 'featuredMedia';
  required: boolean;
  aliases: string[];
}

export const COLUMN_DEFINITIONS: ColumnDefinition[] = [
  {
    canonicalName: 'Project title',
    internalField: 'title',
    required: true,
    aliases: ['project title', 'title']
  },
  {
    canonicalName: 'Short public summary',
    internalField: 'summary',
    required: true,
    aliases: ['short public summary', 'summary']
  },
  {
    canonicalName: 'Project background',
    internalField: 'background',
    required: false,
    aliases: ['project background', 'background']
  },
  {
    canonicalName: 'Solution / impact',
    internalField: 'solution',
    required: false,
    aliases: ['solution / impact', 'solution', 'impact', 'solution/impact']
  },
  {
    canonicalName: 'Team members',
    internalField: 'teamMembers',
    required: true,
    aliases: ['team members', 'teammembers', 'participants']
  },
  {
    canonicalName: 'Group name',
    internalField: 'groupName',
    required: true,
    aliases: ['group name', 'groupname']
  },
  {
    canonicalName: 'Participant contact email',
    internalField: 'participantContactEmail',
    required: false,
    aliases: [
      'participant contact email',
      'participantcontactemail',
      'group contact email',
      'groupcontactemail',
      'participant email',
      'group email',
      'contact email'
    ]
  },
  {
    canonicalName: 'Academic supervisor',
    internalField: 'academicSupervisor',
    required: false,
    aliases: ['academic supervisor', 'academicsupervisor', 'supervisor']
  },
  {
    canonicalName: 'Industry partner',
    internalField: 'industryPartner',
    required: false,
    aliases: ['industry partner', 'industrypartner']
  },
  {
    canonicalName: 'Industry sector',
    internalField: 'industry',
    required: false,
    aliases: ['industry sector', 'industrysector', 'industry']
  },
  {
    canonicalName: 'Study program',
    internalField: 'program',
    required: true,
    aliases: ['study program', 'studyprogram', 'program']
  },
  {
    canonicalName: 'Primary discipline',
    internalField: 'discipline',
    required: true,
    aliases: ['primary discipline', 'primarydiscipline', 'discipline']
  },
  {
    canonicalName: 'Project year',
    internalField: 'year',
    required: true,
    aliases: ['project year', 'projectyear', 'year']
  },
  {
    canonicalName: 'Project video URL',
    internalField: 'videoUrl',
    required: false,
    aliases: [
      'project video url',
      'video url',
      'videourl'
    ]
  },
  {
    canonicalName: 'Live demo URL',
    internalField: 'demoUrl',
    required: false,
    aliases: [
      'live demo url',
      'demo url',
      'demourl',
      'prototype url'
    ]
  },
  {
    canonicalName: 'Source repository URL',
    internalField: 'repositoryUrl',
    required: false,
    aliases: [
      'source repository url',
      'repository url',
      'repositoryurl',
      'repo url'
    ]
  },
  {
    canonicalName: 'Showcase layout',
    internalField: 'templateId',
    required: false,
    aliases: ['showcase layout', 'showcaselayout', 'templateid', 'template id']
  },
  {
    canonicalName: 'Main media to feature',
    internalField: 'featuredMedia',
    required: false,
    aliases: ['main media to feature', 'mainmediatofeature', 'featuredmedia', 'featured media']
  },
  {
    canonicalName: 'Poster full text',
    internalField: 'posterText',
    required: true,
    aliases: ['poster full text', 'poster text', 'postertext', 'posterfulltext']
  },
  {
    canonicalName: 'Accessibility text',
    internalField: 'accessibilityText',
    required: true,
    aliases: ['accessibility text', 'accessibilitytext']
  },
  {
    // Not a required column: required only when the package actually contains snapshot-1.png,
    // which is decided at the package-aware boundary rather than here.
    canonicalName: 'Snapshot image alt text',
    internalField: 'snapshotAltText',
    required: false,
    aliases: [
      'snapshot image alt text',
      'snapshot alt text',
      'snapshot accessibility text',
      'snapshotimagealttext',
      'snapshotalttext',
      'snapshot 1 alt text',
      'snapshot1alttext'
    ]
  },
  {
    canonicalName: 'Snapshot 2 alt text',
    internalField: 'snapshot2AltText',
    required: false,
    aliases: ['snapshot 2 alt text', 'snapshot2 alt text', 'snapshot2alttext']
  },
  {
    canonicalName: 'Snapshot 3 alt text',
    internalField: 'snapshot3AltText',
    required: false,
    aliases: ['snapshot 3 alt text', 'snapshot3 alt text', 'snapshot3alttext']
  },
  {
    canonicalName: 'Snapshot 4 alt text',
    internalField: 'snapshot4AltText',
    required: false,
    aliases: ['snapshot 4 alt text', 'snapshot4 alt text', 'snapshot4alttext']
  },
  {
    canonicalName: 'Snapshot 5 alt text',
    internalField: 'snapshot5AltText',
    required: false,
    aliases: ['snapshot 5 alt text', 'snapshot5 alt text', 'snapshot5alttext']
  },
  {
    canonicalName: 'Snapshot 6 alt text',
    internalField: 'snapshot6AltText',
    required: false,
    aliases: ['snapshot 6 alt text', 'snapshot6 alt text', 'snapshot6alttext']
  },
  {
    canonicalName: 'Snapshot 7 alt text',
    internalField: 'snapshot7AltText',
    required: false,
    aliases: ['snapshot 7 alt text', 'snapshot7 alt text', 'snapshot7alttext']
  },
  {
    canonicalName: 'Snapshot 8 alt text',
    internalField: 'snapshot8AltText',
    required: false,
    aliases: ['snapshot 8 alt text', 'snapshot8 alt text', 'snapshot8alttext']
  },
  {
    canonicalName: 'Snapshot 9 alt text',
    internalField: 'snapshot9AltText',
    required: false,
    aliases: ['snapshot 9 alt text', 'snapshot9 alt text', 'snapshot9alttext']
  },
  {
    canonicalName: 'Snapshot 10 alt text',
    internalField: 'snapshot10AltText',
    required: false,
    aliases: ['snapshot 10 alt text', 'snapshot10 alt text', 'snapshot10alttext']
  },
  // Text-equivalent contract per gallery position. Neither column is a required *column*: they
  // are required exactly when the package contains the image at that position, which only the
  // package-aware boundary can see. Accepted content-type values are the bounded vocabulary in
  // domain/galleryTextEquivalent.ts; any other non-blank value is a parse error, never a default.
  {
    canonicalName: 'Snapshot 1 content type',
    internalField: 'snapshot1ContentKind',
    required: false,
    aliases: ['snapshot 1 content type', 'snapshot1 content type', 'snapshot1contenttype', 'snapshot image content type', 'snapshot content type', 'snapshotcontenttype', 'snapshot 1 image type', 'snapshot image type']
  },
  {
    canonicalName: 'Snapshot 1 full text',
    internalField: 'snapshot1FullText',
    required: false,
    aliases: ['snapshot 1 full text', 'snapshot1 full text', 'snapshot1fulltext', 'snapshot image full text', 'snapshot full text', 'snapshotfulltext', 'snapshot 1 text equivalent', 'snapshot image text equivalent']
  },
  {
    canonicalName: 'Snapshot 2 content type',
    internalField: 'snapshot2ContentKind',
    required: false,
    aliases: ['snapshot 2 content type', 'snapshot2 content type', 'snapshot2contenttype', 'snapshot 2 image type']
  },
  {
    canonicalName: 'Snapshot 2 full text',
    internalField: 'snapshot2FullText',
    required: false,
    aliases: ['snapshot 2 full text', 'snapshot2 full text', 'snapshot2fulltext', 'snapshot 2 text equivalent']
  },
  {
    canonicalName: 'Snapshot 3 content type',
    internalField: 'snapshot3ContentKind',
    required: false,
    aliases: ['snapshot 3 content type', 'snapshot3 content type', 'snapshot3contenttype', 'snapshot 3 image type']
  },
  {
    canonicalName: 'Snapshot 3 full text',
    internalField: 'snapshot3FullText',
    required: false,
    aliases: ['snapshot 3 full text', 'snapshot3 full text', 'snapshot3fulltext', 'snapshot 3 text equivalent']
  },
  {
    canonicalName: 'Snapshot 4 content type',
    internalField: 'snapshot4ContentKind',
    required: false,
    aliases: ['snapshot 4 content type', 'snapshot4 content type', 'snapshot4contenttype', 'snapshot 4 image type']
  },
  {
    canonicalName: 'Snapshot 4 full text',
    internalField: 'snapshot4FullText',
    required: false,
    aliases: ['snapshot 4 full text', 'snapshot4 full text', 'snapshot4fulltext', 'snapshot 4 text equivalent']
  },
  {
    canonicalName: 'Snapshot 5 content type',
    internalField: 'snapshot5ContentKind',
    required: false,
    aliases: ['snapshot 5 content type', 'snapshot5 content type', 'snapshot5contenttype', 'snapshot 5 image type']
  },
  {
    canonicalName: 'Snapshot 5 full text',
    internalField: 'snapshot5FullText',
    required: false,
    aliases: ['snapshot 5 full text', 'snapshot5 full text', 'snapshot5fulltext', 'snapshot 5 text equivalent']
  },
  {
    canonicalName: 'Snapshot 6 content type',
    internalField: 'snapshot6ContentKind',
    required: false,
    aliases: ['snapshot 6 content type', 'snapshot6 content type', 'snapshot6contenttype', 'snapshot 6 image type']
  },
  {
    canonicalName: 'Snapshot 6 full text',
    internalField: 'snapshot6FullText',
    required: false,
    aliases: ['snapshot 6 full text', 'snapshot6 full text', 'snapshot6fulltext', 'snapshot 6 text equivalent']
  },
  {
    canonicalName: 'Snapshot 7 content type',
    internalField: 'snapshot7ContentKind',
    required: false,
    aliases: ['snapshot 7 content type', 'snapshot7 content type', 'snapshot7contenttype', 'snapshot 7 image type']
  },
  {
    canonicalName: 'Snapshot 7 full text',
    internalField: 'snapshot7FullText',
    required: false,
    aliases: ['snapshot 7 full text', 'snapshot7 full text', 'snapshot7fulltext', 'snapshot 7 text equivalent']
  },
  {
    canonicalName: 'Snapshot 8 content type',
    internalField: 'snapshot8ContentKind',
    required: false,
    aliases: ['snapshot 8 content type', 'snapshot8 content type', 'snapshot8contenttype', 'snapshot 8 image type']
  },
  {
    canonicalName: 'Snapshot 8 full text',
    internalField: 'snapshot8FullText',
    required: false,
    aliases: ['snapshot 8 full text', 'snapshot8 full text', 'snapshot8fulltext', 'snapshot 8 text equivalent']
  },
  {
    canonicalName: 'Snapshot 9 content type',
    internalField: 'snapshot9ContentKind',
    required: false,
    aliases: ['snapshot 9 content type', 'snapshot9 content type', 'snapshot9contenttype', 'snapshot 9 image type']
  },
  {
    canonicalName: 'Snapshot 9 full text',
    internalField: 'snapshot9FullText',
    required: false,
    aliases: ['snapshot 9 full text', 'snapshot9 full text', 'snapshot9fulltext', 'snapshot 9 text equivalent']
  },
  {
    canonicalName: 'Snapshot 10 content type',
    internalField: 'snapshot10ContentKind',
    required: false,
    aliases: ['snapshot 10 content type', 'snapshot10 content type', 'snapshot10contenttype', 'snapshot 10 image type']
  },
  {
    canonicalName: 'Snapshot 10 full text',
    internalField: 'snapshot10FullText',
    required: false,
    aliases: ['snapshot 10 full text', 'snapshot10 full text', 'snapshot10fulltext', 'snapshot 10 text equivalent']
  }
];

export function normalizeHeaderString(header: string): string {
  return normalizeOptionString(header);
}

export function findColumnDefinitionForHeader(header: string): ColumnDefinition | null {
  const normalized = normalizeHeaderString(header);
  for (const colDef of COLUMN_DEFINITIONS) {
    for (const alias of colDef.aliases) {
      if (normalizeHeaderString(alias) === normalized) {
        return colDef;
      }
    }
  }
  return null;
}
