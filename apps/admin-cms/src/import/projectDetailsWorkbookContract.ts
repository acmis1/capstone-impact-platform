export interface ProjectDetailsWorkbookIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  fieldName?: string;
  columnName?: string;
  rowNumber?: number;
}

export interface ProjectDetailsWorkbookMetadata {
  title: string;
  summary: string;
  background: string;
  solution: string;
  teamMembers: string[];
  groupName: string;
  academicSupervisor: string;
  industryPartner: string;
  industry: string;
  program: string;
  studyProgram: string;
  discipline: string;
  year: string;
  accessibilityText: string;
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

  constructor(message: string, issues: ProjectDetailsWorkbookIssue[]) {
    super(message);
    this.name = 'ProjectDetailsWorkbookError';
    this.issues = issues;
  }
}

export const PREFERRED_WORKSHEET_NAME = 'Project details';

export const DEFAULT_LAYOUT_CONFIG = {
  templateId: 'poster_showcase',
  featuredMedia: 'poster',
  sectionOrder: ['background', 'solution', 'snapshots', 'video', 'links'],
  hiddenSections: []
} as const;

export interface ColumnDefinition {
  canonicalName: string;
  internalField: keyof ProjectDetailsWorkbookMetadata | 'templateId' | 'featuredMedia';
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
    canonicalName: 'Accessibility text',
    internalField: 'accessibilityText',
    required: false,
    aliases: ['accessibility text', 'accessibilitytext']
  }
];

export function normalizeHeaderString(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, ' ');
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
