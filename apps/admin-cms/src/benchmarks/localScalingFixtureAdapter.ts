import { createHash } from 'node:crypto';
import { Project } from '../domain/project';

export interface AdaptedProjectDbRecord {
  projectRow: Record<string, unknown>;
  mediaRows: Array<Record<string, unknown>>;
  disciplineName: string;
  industryName: string;
}

/**
 * Transforms a domain Project (from generateSyntheticProjects) into production-compliant
 * database rows suitable for direct insertion into Local Supabase tables.
 * 
 * Enforces:
 * - Isolated per-run public_id prefix (`${runPrefix}-${project.publicId}`).
 * - Safe synthetic contact emails with no real stakeholder identity.
 * - Production-compliant media assets with explicit MIME types, positive sizes, and canonical alt text.
 * - Single snapshot_image row per project adhering to database uniqueness constraint.
 */
export function adaptSyntheticProjectForDb(
  project: Project,
  runPrefix: string,
): AdaptedProjectDbRecord {
  const scopedPublicId = `${runPrefix}-${project.publicId}`;
  const isPublished = project.status === 'published';
  const hasSnapshot = (project.snapshots && project.snapshots.length > 0) || (project.snapshotMedia && project.snapshotMedia.length > 0);

  const snapshotUrl = isPublished && hasSnapshot
    ? `https://assets.synthetic.invalid/${scopedPublicId}/snapshot-1.png`
    : undefined;

  const snapshotAlt = hasSnapshot
    ? (project.snapshotMedia?.[0]?.altText || `Synthetic snapshot description for ${scopedPublicId}`)
    : undefined;

  const projectRow: Record<string, unknown> = {
    public_id: scopedPublicId,
    title: project.title,
    summary: project.summary || '',
    background: project.background || '',
    solution: project.solution || '',
    year: parseInt(project.year, 10),
    program_name: project.program || '',
    study_program: project.studyProgram || project.program || '',
    discipline: project.discipline || '',
    industry: project.industry || '',
    industry_partner: project.industryPartner || '',
    academic_supervisor: project.academicSupervisor || '',
    group_name: project.groupName || '',
    participant_contact_email: `${scopedPublicId}-contact@example.test`,
    team_members: project.teamMembers || [],
    poster_url: isPublished ? `https://assets.synthetic.invalid/${scopedPublicId}/poster.png` : null,
    poster_pdf_url: isPublished ? `https://assets.synthetic.invalid/${scopedPublicId}/poster.pdf` : null,
    poster_text_public: project.posterText || 'Synthetic poster text for local scaling verification.',
    accessibility_text_public: project.accessibilityText || 'Synthetic accessibility text for local scaling verification.',
    snapshots: snapshotUrl ? [snapshotUrl] : [],
    video_url: project.videoUrl || null,
    demo_url: project.demoUrl || null,
    repository_url: project.repositoryUrl || null,
    external_links: project.externalLinks || [],
    citations: project.citations || [],
    layout_config: project.layoutConfig || {},
    status: project.status,
    created_at: project.created_at || new Date().toISOString(),
    updated_at: project.updated_at || new Date().toISOString(),
  };

  const mediaRows: Array<Record<string, unknown>> = [
    {
      asset_type: 'poster_image',
      file_name: 'poster.png',
      mime_type: 'image/png',
      file_size_bytes: 1048576,
      storage_bucket: isPublished ? 'project-public-assets' : 'project-drafts-private',
      storage_path: isPublished ? `public/${scopedPublicId}/poster.png` : `drafts/${scopedPublicId}/poster_image/poster.png`,
      is_public_approved: isPublished,
      public_url: isPublished ? `https://assets.synthetic.invalid/${scopedPublicId}/poster.png` : null,
      alt_text_public: null,
    },
    {
      asset_type: 'poster_pdf',
      file_name: 'poster.pdf',
      mime_type: 'application/pdf',
      file_size_bytes: 2097152,
      storage_bucket: isPublished ? 'project-public-assets' : 'project-drafts-private',
      storage_path: isPublished ? `public/${scopedPublicId}/poster.pdf` : `drafts/${scopedPublicId}/poster_pdf/poster.pdf`,
      is_public_approved: isPublished,
      public_url: isPublished ? `https://assets.synthetic.invalid/${scopedPublicId}/poster.pdf` : null,
      alt_text_public: null,
    },
  ];

  if (hasSnapshot) {
    mediaRows.push({
      asset_type: 'snapshot_image',
      file_name: 'snapshot-1.png',
      mime_type: 'image/png',
      file_size_bytes: 524288,
      storage_bucket: isPublished ? 'project-public-assets' : 'project-drafts-private',
      storage_path: isPublished ? `public/${scopedPublicId}/snapshot-1.png` : `drafts/${scopedPublicId}/snapshot_image/snapshot-1.png`,
      is_public_approved: isPublished,
      public_url: snapshotUrl || null,
      alt_text_public: snapshotAlt,
    });
  }

  return {
    projectRow,
    mediaRows,
    disciplineName: project.discipline || 'Synthetic General Discipline',
    industryName: project.industry || 'Synthetic General Industry',
  };
}

export interface DeterministicStoragePayload {
  buffer: Buffer;
  sizeBytes: number;
  sha256: string;
}

/**
 * Creates a deterministic synthetic binary buffer of exact sizeBytes with its SHA-256 hash.
 */
export function createDeterministicStoragePayload(
  sizeBytes: number,
  seedTag: string,
): DeterministicStoragePayload {
  const buffer = Buffer.alloc(sizeBytes);
  const baseTag = Buffer.from(`CAPSTONE_BENCHMARK_PAYLOAD_${seedTag}_`, 'utf8');

  // Fill buffer with repeating patterned bytes derived from seedTag
  for (let offset = 0; offset < sizeBytes; offset += baseTag.length) {
    const chunkLen = Math.min(baseTag.length, sizeBytes - offset);
    baseTag.copy(buffer, offset, 0, chunkLen);
  }

  // XOR with offset-based pseudo-entropy for realistic compressibility
  for (let i = 0; i < sizeBytes; i++) {
    buffer[i] = buffer[i] ^ (i & 0xFF);
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');

  return {
    buffer,
    sizeBytes,
    sha256,
  };
}
