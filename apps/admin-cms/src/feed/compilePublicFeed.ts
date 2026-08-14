import { Project } from '../domain/project';
import { PublicFeedRecord } from '../domain/publicFeed';

/**
 * Compiles internal database records into the sanitized public showcase feed.
 * 
 * Rules:
 * - Only includes projects with a status of 'published'.
 * - Excludes draft, submitted, in_review, changes_requested, approved, archived, and deleted states.
 * - Strips all internal tracking properties, database timestamps, staff comments, and RLS bypass attributes.
 * - Ensures no input mutations occur.
 */
export function compilePublicFeed(projects: Project[]): PublicFeedRecord[] {
  return projects
    .filter((p) => p.status === 'published')
    .map(toPublicFeedRecord);
}

/** The sole allow-listed conversion from an internal project to a public record. */
export function toPublicFeedRecord(p: Project): PublicFeedRecord {
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
        // Copied element-wise rather than by reference so the compiled record can never be mutated
        // through the source project, and normalised to the exact two-key public shape.
        snapshotMedia: Array.isArray(p.snapshotMedia)
          ? p.snapshotMedia.map((item) => ({ url: item.url, altText: item.altText }))
          : [],
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
}

/**
 * Builds the exact proposed artifact for one approved target without changing any project.
 * Existing published projects form the baseline; all other non-public records are excluded.
 */
export function compilePublicationCandidateFeed(projects: Project[], targetPublicId: string): PublicFeedRecord[] {
  const targets = projects.filter((project) => project.publicId === targetPublicId);
  if (targets.length !== 1 || targets[0].status !== 'approved') {
    throw new Error('Publication candidate target is unavailable.');
  }
  return projects
    .filter((project) => project.status === 'published' || project.publicId === targetPublicId)
    .map(toPublicFeedRecord);
}

/** Builds a public-feed candidate with one exact published target removed. */
export function compilePublicRemovalCandidateFeed(projects: Project[], targetPublicId: string): PublicFeedRecord[] {
  const targets = projects.filter((project) => project.publicId === targetPublicId);
  if (targets.length !== 1 || targets[0].status !== 'published') {
    throw new Error('Public-removal candidate target is unavailable.');
  }
  return projects
    .filter((project) => project.status === 'published' && project.publicId !== targetPublicId)
    .map(toPublicFeedRecord);
}
