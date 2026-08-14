import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { Project } from '../domain/project';

export interface AdaptedProjectDbRecord {
  projectRow: Record<string, unknown>;
  mediaRows: Array<Record<string, unknown>>;
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
  };
}

export interface DeterministicStoragePayload {
  buffer: Buffer;
  sizeBytes: number;
  sha256: string;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buffer: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

/**
 * Creates a valid deterministic PNG of exactly sizeBytes with its SHA-256 hash. A private
 * ancillary chunk carries deterministic padding so the benchmark truthfully uploads image/png.
 */
export function createDeterministicStoragePayload(
  sizeBytes: number,
  seedTag: string,
): DeterministicStoragePayload {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const idat = deflateSync(Buffer.from([0, 0, 0, 0, 0]));
  const fixedSize = PNG_SIGNATURE.length
    + pngChunk('IHDR', ihdr).length
    + pngChunk('IDAT', idat).length
    + pngChunk('IEND', Buffer.alloc(0)).length
    + 12;
  const paddingSize = sizeBytes - fixedSize;
  if (paddingSize < 0) {
    throw new Error(`Synthetic PNG size must be at least ${fixedSize} bytes.`);
  }

  const padding = Buffer.alloc(paddingSize);
  const baseTag = Buffer.from(`CAPSTONE_BENCHMARK_PAYLOAD_${seedTag}_`, 'utf8');

  for (let offset = 0; offset < padding.length; offset += baseTag.length) {
    const chunkLen = Math.min(baseTag.length, padding.length - offset);
    baseTag.copy(padding, offset, 0, chunkLen);
  }

  for (let i = 0; i < padding.length; i++) {
    padding[i] = padding[i] ^ (i & 0xFF);
  }

  const buffer = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('pADd', padding),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

  const sha256 = createHash('sha256').update(buffer).digest('hex');

  return {
    buffer,
    sizeBytes,
    sha256,
  };
}
