import { ImportPackageManifest } from './importTypes';

export interface ProjectDetailsJsonIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  fieldName?: string;
}

export class ProjectDetailsJsonError extends Error {
  readonly issues: ProjectDetailsJsonIssue[];
  readonly errors: ProjectDetailsJsonIssue[];
  readonly warnings: ProjectDetailsJsonIssue[];

  constructor(issues: ProjectDetailsJsonIssue[]) {
    const errorCount = issues.filter((i) => i.severity === 'error').length;
    super(`JSON metadata parsing failed with ${errorCount} error(s).`);
    this.name = 'ProjectDetailsJsonError';
    this.issues = issues;
    this.errors = issues.filter((i) => i.severity === 'error');
    this.warnings = issues.filter((i) => i.severity === 'warning');
  }
}

/**
 * Pure in-memory parser for legacy developer/testing project.json metadata files.
 * 
 * Safe Messaging Rule:
 * Does NOT leak raw JSON parser exceptions, stack traces, or raw uploaded content in error messages.
 */
export function parseProjectDetailsJson(
  input: string | Buffer | Uint8Array,
  fallbackPublicId: string
): { manifest: ImportPackageManifest; warnings: ProjectDetailsJsonIssue[] } {
  const issues: ProjectDetailsJsonIssue[] = [];

  let text = '';
  if (typeof input === 'string') {
    text = input;
  } else {
    text = Buffer.from(input).toString('utf-8');
  }

  let rawObj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      issues.push({
        code: 'PACKAGE_MALFORMED_JSON',
        message: 'The metadata JSON content is not a valid JSON object.',
        severity: 'error',
      });
      throw new ProjectDetailsJsonError(issues);
    }
    rawObj = parsed as Record<string, unknown>;
  } catch (err: unknown) {
    if (err instanceof ProjectDetailsJsonError) throw err;
    issues.push({
      code: 'PACKAGE_MALFORMED_JSON',
      message: 'The metadata JSON file could not be parsed.',
      severity: 'error',
    });
    throw new ProjectDetailsJsonError(issues);
  }

  const getString = (key: string, defaultVal = ''): string => {
    const val = rawObj[key];
    if (typeof val === 'string') return val.trim();
    if (typeof val === 'number') return String(val);
    return defaultVal;
  };

  const title = getString('title');
  const summary = getString('summary');
  const background = getString('background');
  const solution = getString('solution');
  const yearRaw = getString('year');
  const program = getString('program', getString('studyProgram'));
  const studyProgram = getString('studyProgram', program);
  const discipline = getString('discipline');
  const industry = getString('industry');
  const industryPartner = getString('industryPartner');
  const academicSupervisor = getString('academicSupervisor', getString('supervisor'));
  const groupName = getString('groupName');
  const posterText = getString('posterText');
  const accessibilityText = getString('accessibilityText');

  let teamMembers: string[] = [];
  if (Array.isArray(rawObj.teamMembers)) {
    teamMembers = rawObj.teamMembers
      .map((m) => (typeof m === 'string' ? m.trim() : ''))
      .filter((m) => m !== '');
  } else if (Array.isArray(rawObj.participants)) {
    teamMembers = rawObj.participants
      .map((m) => (typeof m === 'string' ? m.trim() : ''))
      .filter((m) => m !== '');
  }

  let layoutConfig: Record<string, unknown> = {};
  if (rawObj.layoutConfig && typeof rawObj.layoutConfig === 'object' && !Array.isArray(rawObj.layoutConfig)) {
    layoutConfig = { ...(rawObj.layoutConfig as Record<string, unknown>) };
  } else {
    layoutConfig = {
      templateId: 'poster_showcase',
      featuredMedia: 'poster',
      sectionOrder: ['poster', 'summary', 'background', 'solution', 'snapshots'],
      hiddenSections: [],
    };
  }

  const publicId = getString('publicId', fallbackPublicId);

  const manifest: ImportPackageManifest = {
    publicId,
    title,
    summary,
    background,
    solution,
    year: yearRaw,
    program,
    studyProgram,
    discipline,
    industry,
    industryPartner,
    academicSupervisor,
    groupName,
    teamMembers,
    posterText: posterText || undefined,
    accessibilityText: accessibilityText || undefined,
    layoutConfig,
  };

  return { manifest, warnings: issues.filter((i) => i.severity === 'warning') };
}
