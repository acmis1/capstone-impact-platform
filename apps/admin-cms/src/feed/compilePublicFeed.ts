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
      // Deconstruct to exclude internal-only properties
      const {
        status,
        importBatchId,
        sourceFolder,
        internalStaffNotes,
        privateReviewComments,
        validationFlags,
        validationErrors,
        validationWarnings,
        pendingRemovalFromPublic,
        publicRemovalCompletedAt,
        archivedAt,
        archivedFromStatus,
        archiveReason,
        created_at,
        updated_at,
        ...publicRecord
      } = p;

      // Ensure optional fields are handled correctly without introducing empty values or schema issues
      return {
        id: publicRecord.id,
        publicId: publicRecord.publicId || '',
        title: publicRecord.title || '',
        summary: publicRecord.summary || '',
        background: publicRecord.background || '',
        solution: publicRecord.solution || '',
        year: publicRecord.year || '',
        program: publicRecord.program || '',
        studyProgram: publicRecord.studyProgram || '',
        discipline: publicRecord.discipline || '',
        disciplines: Array.isArray(publicRecord.disciplines) ? publicRecord.disciplines : [],
        industry: publicRecord.industry || '',
        industryPartner: publicRecord.industryPartner || '',
        academicSupervisor: publicRecord.academicSupervisor || '',
        groupName: publicRecord.groupName || '',
        teamMembers: Array.isArray(publicRecord.teamMembers) ? publicRecord.teamMembers : [],
        poster: publicRecord.poster || '',
        posterPdf: publicRecord.posterPdf || '',
        posterText: publicRecord.posterText || '',
        accessibilityText: publicRecord.accessibilityText || '',
        snapshots: Array.isArray(publicRecord.snapshots) ? publicRecord.snapshots : [],
        // Include optional fields conditionally if defined
        ...(publicRecord.videoUrl ? { videoUrl: publicRecord.videoUrl } : {}),
        ...(publicRecord.demoUrl ? { demoUrl: publicRecord.demoUrl } : {}),
        ...(publicRecord.repositoryUrl ? { repositoryUrl: publicRecord.repositoryUrl } : {}),
        ...(Array.isArray(publicRecord.externalLinks) && publicRecord.externalLinks.length > 0
          ? { externalLinks: publicRecord.externalLinks }
          : {}),
        ...(Array.isArray(publicRecord.citations) && publicRecord.citations.length > 0
          ? { citations: publicRecord.citations }
          : {}),
        layoutConfig: {
          templateId: publicRecord.layoutConfig?.templateId || 'poster_showcase',
          featuredMedia: publicRecord.layoutConfig?.featuredMedia || 'poster',
          sectionOrder: Array.isArray(publicRecord.layoutConfig?.sectionOrder)
            ? publicRecord.layoutConfig.sectionOrder
            : ['background', 'solution', 'snapshots', 'video', 'links'],
          ...(Array.isArray(publicRecord.layoutConfig?.hiddenSections)
            ? { hiddenSections: publicRecord.layoutConfig.hiddenSections }
            : {}),
        },
      };
    });
}
