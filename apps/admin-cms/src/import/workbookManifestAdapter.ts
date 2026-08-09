import { ImportPackageManifest } from './importTypes';
import { ProjectDetailsWorkbookParseResult } from './projectDetailsWorkbookContract';

export interface BuildImportPackageManifestOptions {
  parsedWorkbook: ProjectDetailsWorkbookParseResult;
  publicId: string;
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
    teamMembers: [...metadata.teamMembers],
    ...(posterText ? { posterText: posterText.trim() } : {}),
    ...(metadata.accessibilityText ? { accessibilityText: metadata.accessibilityText } : {}),
    layoutConfig: {
      templateId: metadata.layoutConfig.templateId,
      featuredMedia: metadata.layoutConfig.featuredMedia,
      sectionOrder: [...metadata.layoutConfig.sectionOrder],
      hiddenSections: [...metadata.layoutConfig.hiddenSections]
    }
  };
}
