import { ImportPackageManifest } from './importTypes';
import { validateParticipantContactEmail } from '../domain/participantContactEmail';
import { ACCESSIBLE_CONTENT_LIMITS } from '../domain/accessibleContent';

export interface ProjectDetailsJsonWarning {
  code: string;
  message: string;
  fieldName?: string;
}

export interface ProjectDetailsJsonParseResult {
  manifest: ImportPackageManifest;
  warnings: ProjectDetailsJsonWarning[];
}

export class ProjectDetailsJsonError extends Error {
  readonly issues: Array<{ code: string; message: string; severity: 'error'; fieldName?: string }>;

  constructor(issues: Array<{ code: string; message: string; severity: 'error'; fieldName?: string }>) {
    super('The metadata JSON file could not be parsed.');
    this.name = 'ProjectDetailsJsonError';
    this.issues = issues;
  }
}

/**
 * Pure in-memory parser for legacy developer/testing project.json metadata files.
 * Folder-derived public ID is strictly authoritative; any publicId field in JSON is ignored.
 */
export function parseProjectDetailsJson(
  jsonBuffer: Buffer | string,
  fallbackPublicId: string
): ProjectDetailsJsonParseResult {
  const warnings: ProjectDetailsJsonWarning[] = [];
  const errors: Array<{ code: string; message: string; severity: 'error'; fieldName?: string }> = [];

  let jsonStr = '';
  if (Buffer.isBuffer(jsonBuffer)) {
    jsonStr = jsonBuffer.toString('utf-8');
  } else if (typeof jsonBuffer === 'string') {
    jsonStr = jsonBuffer;
  } else {
    throw new ProjectDetailsJsonError([
      { code: 'JSON_MALFORMED', message: 'The metadata JSON file content was invalid.', severity: 'error' },
    ]);
  }

  let obj: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error();
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    throw new ProjectDetailsJsonError([
      { code: 'JSON_MALFORMED', message: 'The metadata JSON file could not be parsed as valid JSON.', severity: 'error' },
    ]);
  }

  // Step 7: Folder-derived public ID is strictly authoritative. Ignore any publicId in JSON.
  if ('publicId' in obj && obj.publicId !== undefined) {
    warnings.push({
      code: 'JSON_PUBLIC_ID_IGNORED',
      message: 'The publicId property in project.json was ignored in favor of the folder name.',
      fieldName: 'publicId',
    });
  }

  const getString = (key: string, defaultValue = ''): string => {
    const val = obj[key];
    if (typeof val === 'string') return val.trim();
    if (typeof val === 'number') return String(val);
    return defaultValue;
  };

  const getArrayStrings = (key: string): string[] => {
    const val = obj[key];
    if (!Array.isArray(val)) return [];
    return val
      .filter((item: unknown) => typeof item === 'string' || typeof item === 'number')
      .map((item: unknown) => String(item).trim())
      .filter((item: string) => item.length > 0);
  };

  const title = getString('title');
  const summary = getString('summary');
  const background = getString('background');
  const solution = getString('solution');
  const year = getString('year');
  const program = getString('program') || getString('studyProgram');
  const studyProgram = getString('studyProgram') || program;
  const discipline = getString('discipline');
  const industry = getString('industry');
  const industryPartner = getString('industryPartner');
  const academicSupervisor = getString('academicSupervisor');
  const groupName = getString('groupName');
  // Legacy JSON manifests predate the contact-email contract. An absent or unusable value simply
  // yields no authoritative contact — Generate + Send then fails closed with a bounded result —
  // rather than blocking an otherwise valid import.
  const contactEmailValidation = validateParticipantContactEmail(getString('participantContactEmail'));
  const participantContactEmail = contactEmailValidation.valid ? contactEmailValidation.email : '';
  const posterText = getString('posterText');
  const accessibilityText = getString('accessibilityText');
  // Legacy JSON manifests predate the snapshot-alt contract, so an absent value is not an error
  // here — a legacy package may still be staged into private draft media, and staff supply the alt
  // text through the project media surface before the project can progress any further. A value
  // that IS supplied must be usable, so an oversized one is rejected outright rather than
  // truncated: nothing in this codebase invents or shortens accessibility text.
  const snapshotAltText = getString('snapshotAltText');
  if (snapshotAltText.length > ACCESSIBLE_CONTENT_LIMITS.snapshotAltText) {
    errors.push({
      code: 'JSON_VALUE_TOO_LONG',
      message: `The "snapshotAltText" value exceeds the maximum of ${ACCESSIBLE_CONTENT_LIMITS.snapshotAltText} characters.`,
      severity: 'error',
      fieldName: 'snapshotAltText',
    });
  }
  const teamMembers = getArrayStrings('teamMembers');

  const rawLayout = obj.layoutConfig && typeof obj.layoutConfig === 'object' ? (obj.layoutConfig as Record<string, unknown>) : {};
  const templateId = typeof rawLayout.templateId === 'string' ? rawLayout.templateId.trim() : 'poster_showcase';
  const featuredMedia = typeof rawLayout.featuredMedia === 'string' ? rawLayout.featuredMedia.trim() : 'poster';
  const sectionOrder = Array.isArray(rawLayout.sectionOrder)
    ? rawLayout.sectionOrder.filter((s: unknown): s is string => typeof s === 'string')
    : [];
  const hiddenSections = Array.isArray(rawLayout.hiddenSections)
    ? rawLayout.hiddenSections.filter((s: unknown): s is string => typeof s === 'string')
    : [];

  const manifest: ImportPackageManifest = {
    publicId: fallbackPublicId.trim(),
    title,
    summary,
    background,
    solution,
    year,
    program,
    studyProgram,
    discipline,
    industry,
    industryPartner,
    academicSupervisor,
    groupName,
    participantContactEmail,
    teamMembers,
    ...(posterText ? { posterText } : {}),
    ...(accessibilityText ? { accessibilityText } : {}),
    ...(snapshotAltText ? { snapshotAltText } : {}),
    layoutConfig: {
      templateId,
      featuredMedia,
      sectionOrder,
      hiddenSections,
    },
  };

  if (errors.length > 0) {
    throw new ProjectDetailsJsonError(errors);
  }

  return { manifest, warnings };
}
