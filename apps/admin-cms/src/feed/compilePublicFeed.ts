import { Project } from '../domain/project';
import { PublicFeedRecord } from '../domain/publicFeed';

/**
 * Compiles internal database records into the sanitized public showcase feed.
 * 
 * Rules:
 * - Only includes projects with a status of 'approved' or 'published'.
 * - Excludes draft, submitted, in_review, changes_requested, archived, and deleted states.
 * - Strips all internal tracking properties, database timestamps, staff comments, and RLS bypass attributes.
 * - Ensures no input mutations occur.
 */
export function compilePublicFeed(projects: Project[]): PublicFeedRecord[] {
  return projects
    .filter((p) => p.status === 'approved' || p.status === 'published')
    .map((p) => {
      // Explicitly construct public feed record from approved allowlist properties
      return {
        id: p.id,
        publicId: p.publicId || '',
        title: p.title || '',
        summary: p.summary || '',
        background: p.background || '',
        solution: p.solution || '',
        year: p.year || '',
        program: p.program || '',
        studyProgram: p.studyProgram || '',
        discipline: p.discipline || '',
        disciplines: Array.isArray(p.disciplines) ? p.disciplines : [],
        industry: p.industry || '',
        industryPartner: p.industryPartner || '',
        academicSupervisor: p.academicSupervisor || '',
        groupName: p.groupName || '',
        teamMembers: Array.isArray(p.teamMembers) ? p.teamMembers : [],
        poster: p.poster || '',
        posterPdf: p.posterPdf || '',
        posterText: p.posterText || '',
        accessibilityText: p.accessibilityText || '',
        snapshots: Array.isArray(p.snapshots) ? p.snapshots : [],
        // Include optional fields conditionally if defined
        ...(p.videoUrl ? { videoUrl: p.videoUrl } : {}),
        ...(p.demoUrl ? { demoUrl: p.demoUrl } : {}),
        ...(p.repositoryUrl ? { repositoryUrl: p.repositoryUrl } : {}),
        ...(Array.isArray(p.externalLinks) && p.externalLinks.length > 0
          ? { externalLinks: p.externalLinks }
          : {}),
        ...(Array.isArray(p.citations) && p.citations.length > 0
          ? { citations: p.citations }
          : {}),
        layoutConfig: {
          templateId: p.layoutConfig?.templateId || 'poster_showcase',
          featuredMedia: p.layoutConfig?.featuredMedia || 'poster',
          sectionOrder: Array.isArray(p.layoutConfig?.sectionOrder)
            ? p.layoutConfig.sectionOrder
            : ['background', 'solution', 'snapshots', 'video', 'links'],
          ...(Array.isArray(p.layoutConfig?.hiddenSections)
            ? { hiddenSections: p.layoutConfig.hiddenSections }
            : {}),
        },
      };
    });
}
