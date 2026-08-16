import { ImportPackageManifest } from './importTypes';
import { ProjectDetailsWorkbookParseResult } from './projectDetailsWorkbookContract';

export interface BuildImportPackageManifestOptions {
  parsedWorkbook: ProjectDetailsWorkbookParseResult;
  publicId: string;
  /**
   * Optional caller-supplied override for poster full text. The workbook is the canonical source
   * and already guarantees a non-blank value; this remains only for callers that carry the text
   * out of band. A blank override never erases the workbook value.
   */
  posterText?: string;
}

export function buildImportPackageManifestFromWorkbook(
  options: BuildImportPackageManifestOptions
): ImportPackageManifest {
  const { parsedWorkbook, publicId, posterText } = options;

  if (!publicId || typeof publicId !== 'string' || publicId.trim() === '') {
    throw new Error('Adapter Error: "publicId" must be provided by the caller and cannot be empty.');
  }

  const metadata = parsedWorkbook.metadata;
  const resolvedPosterText = (posterText && posterText.trim() !== '' ? posterText : metadata.posterText).trim();

  return {
    publicId: publicId.trim(),
    title: metadata.title,
    summary: metadata.summary,
    background: metadata.background || '',
    solution: metadata.solution || '',
    year: metadata.year,
    program: metadata.program,
    studyProgram: metadata.studyProgram || metadata.program,
    discipline: metadata.discipline,
    industry: metadata.industry || '',
    industryPartner: metadata.industryPartner || '',
    academicSupervisor: metadata.academicSupervisor || '',
    groupName: metadata.groupName,
    participantContactEmail: metadata.participantContactEmail || '',
    teamMembers: [...metadata.teamMembers],
    ...(resolvedPosterText ? { posterText: resolvedPosterText } : {}),
    ...(metadata.accessibilityText ? { accessibilityText: metadata.accessibilityText } : {}),
    ...(metadata.snapshotAltText ? { snapshotAltText: metadata.snapshotAltText } : {}),
    layoutConfig: {
      templateId: metadata.layoutConfig.templateId,
      featuredMedia: metadata.layoutConfig.featuredMedia,
      sectionOrder: [...metadata.layoutConfig.sectionOrder],
      hiddenSections: [...metadata.layoutConfig.hiddenSections]
    }
  };
}
