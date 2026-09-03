import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { correctionDigest } from './participantCorrectionPackage';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const fileSchema = z.object({
  role: z.enum(['workbook', 'poster_image', 'poster_pdf', 'snapshot_image']),
  position: z.number().int().min(1).max(10).nullable(),
  fileName: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/).refine((s) => !s.includes('..')),
  storageName: z.string().regex(/^(workbook|poster_image|poster_pdf|snapshot_image-[1-9][0-9]?)\.(xlsx|png|jpg|jpeg|webp|pdf)$/),
  mimeType: z.string(), bytes: z.number().int().positive().max(20 * 1024 * 1024), sha256: hash,
  altText: z.string().max(2000).nullable(),
}).strict();
const submissionSchema = z.object({
  id: z.uuid(), project_id: z.uuid(), correction_request_id: z.uuid().nullable(), participant_preview_id: z.uuid().nullable(),
  source: z.enum(['participant_capability', 'staff_pre_preview']), base_version: hash.nullable(),
  validation_checks: z.array(z.object({ ruleCode: z.string(), fieldName: z.string().nullable() }).strict()),
  package_hash: hash, metadata: z.record(z.string(), z.unknown()), files: z.array(fileSchema).min(3).max(13),
  warnings: z.array(z.string()), storage_bucket: z.literal('participant-corrections-private'),
  state: z.enum(['preparing', 'submitted', 'superseded', 'frozen', 'accepted', 'returned']),
  submitted_at: z.string().nullable(), frozen_at: z.string().nullable(), frozen_version: hash.nullable(),
});
type Submission = z.infer<typeof submissionSchema>;
type CorrectionFile = z.infer<typeof fileSchema>;

export const correctionDecisionSchema = z.object({
  action: z.enum(['begin', 'accept', 'return']), submissionId: z.uuid(), packageHash: hash, expectedVersion: hash,
}).strict();
export type CorrectionDecision = z.infer<typeof correctionDecisionSchema>;

const CONTENT_FIELDS = {
  title: 'title', summary: 'summary', background: 'background', solution: 'solution', year: 'year',
  program: 'program_name', studyProgram: 'study_program', discipline: 'discipline', industry: 'industry',
  industryPartner: 'industry_partner', academicSupervisor: 'academic_supervisor', groupName: 'group_name',
  participantContactEmail: 'participant_contact_email', teamMembers: 'team_members',
  posterText: 'poster_text_public', accessibilityText: 'accessibility_text_public',
  videoUrl: 'video_url', demoUrl: 'demo_url', repositoryUrl: 'repository_url', layoutConfig: 'layout_config',
} as const;

export interface CorrectionReviewView {
  available: boolean;
  candidate: null | {
    id: string; hash: string; expectedVersion: string; state: Submission['state']; submittedAt: string;
    fields: Array<{ name: string; current: string; proposed: string; changed: boolean }>;
    files: Array<{ role: string; position: number | null; fileName: string; bytes: number; hash: string; altText: string | null; url: string }>;
    currentMedia: Array<{ role: string; position: number | null; fileName: string; hash: string; altText: string | null }>;
    warnings: string[];
    validationFlags: Array<{ message: string; resolved: boolean; willResolve: boolean }>;
  };
}
const unavailable: CorrectionReviewView = { available: false, candidate: null };
const printable = (value: unknown) => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
const candidatePath = (s: Submission, f: CorrectionFile) => `corrections/${s.project_id}/${s.correction_request_id ?? s.id}/${s.id}/${f.storageName}`;
const draftPath = (publicId: string, s: Submission, f: CorrectionFile) => `drafts/${publicId}/${f.role}/corrections/${s.id}/${f.storageName}/${f.fileName}`;

async function verifiedBytes(client: SupabaseClient, bucket: string, path: string, file: { bytes: number; sha256?: string }): Promise<Buffer> {
  const downloaded = await client.storage.from(bucket).download(path);
  if (downloaded.error || !downloaded.data || downloaded.data.size !== file.bytes) throw new Error('CORRECTION_MEDIA_UNAVAILABLE');
  const bytes = Buffer.from(await downloaded.data.arrayBuffer());
  if (file.sha256 && correctionDigest(bytes) !== file.sha256) throw new Error('CORRECTION_MEDIA_UNAVAILABLE');
  return bytes;
}

/** Read-only staff evidence. Current values are compared with the immutable candidate, never supplied by the browser. */
export async function loadCorrectionReviewView(client: SupabaseClient, publicId: string, correctionId: string | null, prePreview = false): Promise<CorrectionReviewView> {
  if (!correctionId && !prePreview) return { available: true, candidate: null };
  try {
    const project = await client.from('projects').select('*').eq('public_id', publicId).is('deleted_at', null).single();
    if (project.error || !project.data) return unavailable;
    const query = client.from('participant_correction_submissions').select('*').eq('project_id', project.data.id);
    const candidates = await (prePreview ? query.eq('source', 'staff_pre_preview') : query.eq('correction_request_id', correctionId))
      .in('state', ['submitted', 'frozen', 'accepted', 'returned']).order('reserved_at', { ascending: false }).limit(1);
    if (candidates.error) return unavailable;
    if (!candidates.data?.length) return { available: true, candidate: null };
    const s = submissionSchema.parse(candidates.data[0]);
    const version = await client.rpc('participant_correction_project_version', { p_project_id: project.data.id });
    if (version.error || !hash.safeParse(version.data).success) return unavailable;
    const files = [];
    for (const file of s.files) {
      await verifiedBytes(client, s.storage_bucket, candidatePath(s, file), file);
      const signed = await client.storage.from(s.storage_bucket).createSignedUrl(candidatePath(s, file), 300);
      if (signed.error || !signed.data?.signedUrl) return unavailable;
      files.push({ role: file.role, position: file.position, fileName: file.fileName, bytes: file.bytes, hash: file.sha256, altText: file.altText, url: signed.data.signedUrl });
    }
    const media = await client.from('media_assets').select('*').eq('project_id', project.data.id);
    if (media.error || !media.data || media.data.length > 12) return unavailable;
    const currentMedia = [];
    for (const m of media.data) {
      if (m.storage_bucket !== 'project-drafts-private' || m.is_public_approved !== false || m.public_url || m.public_storage_path || m.public_storage_bucket ||
          !Number.isSafeInteger(m.file_size_bytes) || m.file_size_bytes < 1 || m.file_size_bytes > 20 * 1024 * 1024) return unavailable;
      const bytes = await verifiedBytes(client, m.storage_bucket, m.storage_path, { bytes: m.file_size_bytes });
      currentMedia.push({ role: m.asset_type, position: m.gallery_position, fileName: m.file_name, hash: correctionDigest(bytes), altText: m.alt_text_public });
    }
    // Include complete taxonomy mappings rather than only the legacy first-value columns.
    const disciplines = await client.from('project_disciplines').select('disciplines(name)').eq('project_id', project.data.id);
    const industries = await client.from('project_industry_categories').select('industry_categories(name)').eq('project_id', project.data.id);
    if (disciplines.error || industries.error) return unavailable;
    const names = (rows: unknown[], key: string) => rows.map((row) => z.object({ [key]: z.object({ name: z.string() }) }).parse(row)[key].name).join(', ');
    const current = { ...project.data, discipline: names(disciplines.data ?? [], 'disciplines'), industry: names(industries.data ?? [], 'industry_categories') };
    const flags = await client.from('validation_flags').select('rule_code,field_name,message,resolved').eq('project_id', project.data.id);
    if (flags.error || !flags.data) return unavailable;
    const finalVersion = await client.rpc('participant_correction_project_version', { p_project_id: project.data.id });
    if (finalVersion.error || finalVersion.data !== version.data) return unavailable;
    return { available: true, candidate: {
      id: s.id, hash: s.package_hash, expectedVersion: s.frozen_version ?? s.base_version ?? version.data, state: s.state, submittedAt: s.submitted_at!,
      fields: Object.entries(CONTENT_FIELDS).map(([name, column]) => {
        const before = printable(current[column]); const after = printable(s.metadata[name]);
        return { name, current: before, proposed: after, changed: before !== after };
      }), files, currentMedia, warnings: s.warnings,
      validationFlags: flags.data.map((flag) => ({ message: flag.message, resolved: flag.resolved === true,
        willResolve: flag.resolved !== true && s.validation_checks.some((check) => check.ruleCode === flag.rule_code && check.fieldName === flag.field_name) })),
    } };
  } catch { return unavailable; }
}

/** Verify actual bytes, stage immutable draft copies, then apply only the exact DB-frozen candidate. */
export async function decideParticipantCorrection(client: SupabaseClient, publicId: string, adminId: string, input: CorrectionDecision): Promise<{ success: boolean; code: string }> {
  try {
    const parsed = correctionDecisionSchema.safeParse(input);
    if (!parsed.success) return { success: false, code: 'INVALID_SELECTION' };
    const project = await client.from('projects').select('id').eq('public_id', publicId).is('deleted_at', null).single();
    if (project.error || !project.data) return { success: false, code: 'UNAVAILABLE' };
    const found = await client.from('participant_correction_submissions').select('*').eq('id', input.submissionId).eq('project_id', project.data.id).eq('package_hash', input.packageHash).single();
    if (found.error) return { success: false, code: 'UNAVAILABLE' };
    const s = submissionSchema.parse(found.data);
    if (input.action === 'begin' || (input.action === 'accept' && s.state !== 'accepted')) {
      if ((input.action === 'begin' && s.state !== 'submitted') || (input.action === 'accept' && s.state !== 'frozen')) return { success: false, code: 'UNAVAILABLE' };
      const version = await client.rpc('participant_correction_project_version', { p_project_id: project.data.id });
      if (version.error || version.data !== input.expectedVersion || (s.frozen_version && s.frozen_version !== input.expectedVersion)) return { success: false, code: 'STALE_REVISION' };
      for (const file of s.files) {
        const bytes = await verifiedBytes(client, s.storage_bucket, candidatePath(s, file), file);
        if (input.action === 'accept' && file.role !== 'workbook') {
          const path = draftPath(publicId, s, file);
          await client.storage.from('project-drafts-private').upload(path, bytes, { upsert: false, contentType: file.mimeType });
          // Download even after a successful upload; reused copies must match byte-for-byte too.
          await verifiedBytes(client, 'project-drafts-private', path, file);
        }
      }
    }
    const result = await client.rpc('review_participant_correction', {
      p_public_id: publicId, p_admin_id: adminId, p_submission_id: input.submissionId,
      p_package_hash: input.packageHash, p_expected_version: input.expectedVersion, p_action: input.action,
    });
    const code = result.error ? 'UNAVAILABLE' : result.data?.resultCode;
    return { success: code === 'SUCCESS', code: ['SUCCESS', 'STALE_REVISION', 'PERMISSION_DENIED', 'STORAGE_INCOMPLETE', 'UNSAFE_REVISION'].includes(code) ? code : 'UNAVAILABLE' };
  } catch { return { success: false, code: 'UNAVAILABLE' }; }
}
