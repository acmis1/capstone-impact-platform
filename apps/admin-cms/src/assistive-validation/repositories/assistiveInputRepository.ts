import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { postgresCanonicalUuidSchema } from '../domain/persistenceContract';
import { DUPLICATE_SHORTLIST_LIMITS } from '../duplicate-detection/duplicateRanker';

const projectRowSchema = z.object({
  id: postgresCanonicalUuidSchema,
  public_id: z.string().min(1).max(DUPLICATE_SHORTLIST_LIMITS.publicId).regex(/^[A-Za-z0-9_-]+$/),
  title: z.string().max(DUPLICATE_SHORTLIST_LIMITS.title).nullable(),
  summary: z.string().max(DUPLICATE_SHORTLIST_LIMITS.summary).nullable(),
  background: z.string().max(DUPLICATE_SHORTLIST_LIMITS.background).nullable(),
  solution: z.string().max(DUPLICATE_SHORTLIST_LIMITS.solution).nullable(),
}).strict();

const duplicateCandidateRowSchema = projectRowSchema.omit({ id: true });

const assetRowSchema = z.object({
  id: postgresCanonicalUuidSchema,
  asset_type: z.enum(['poster_pdf', 'poster_image']),
  file_name: z.string().min(1).max(255),
  storage_bucket: z.string().min(1).max(100),
  storage_path: z.string().min(1).max(1024),
  mime_type: z.string().nullable(),
  file_size_bytes: z.number().int().positive().nullable(),
  created_at: z.string().min(1),
}).strict();

export type AssistiveProjectRow = z.infer<typeof projectRowSchema>;
export type AssistiveDuplicateCandidateRow = z.infer<typeof duplicateCandidateRowSchema>;
export type AssistiveAssetRow = z.infer<typeof assetRowSchema>;

export interface AssistiveInputGateway {
  loadProject(projectId: string): Promise<AssistiveProjectRow | null>;
  loadDuplicateCandidates(projectId: string): Promise<AssistiveDuplicateCandidateRow[]>;
  loadPosterAssets(projectId: string, privateBucket: string): Promise<AssistiveAssetRow[]>;
  download(bucket: string, path: string): Promise<Buffer>;
}

export class SupabaseAssistiveInputRepository implements AssistiveInputGateway {
  constructor(private readonly client: SupabaseClient) {}

  async loadProject(projectId: string): Promise<AssistiveProjectRow | null> {
    const result = await this.client.from('projects')
      .select('id,public_id,title,summary,background,solution')
      .eq('id', projectId)
      .is('deleted_at', null)
      .maybeSingle();
    if (result.error) throw new Error('ASSISTIVE_PROJECT_READ_FAILED');
    return result.data === null ? null : projectRowSchema.parse(result.data);
  }

  async loadDuplicateCandidates(projectId: string): Promise<AssistiveDuplicateCandidateRow[]> {
    const result = await this.client.from('projects')
      .select('public_id,title,summary,background,solution', { count: 'exact' })
      .neq('id', projectId)
      .is('deleted_at', null)
      .order('public_id', { ascending: true })
      .limit(DUPLICATE_SHORTLIST_LIMITS.candidatePool);
    if (result.error) throw new Error('ASSISTIVE_DUPLICATE_CANDIDATE_READ_FAILED');
    if (result.count === null) throw new Error('ASSISTIVE_DUPLICATE_CANDIDATE_COUNT_UNAVAILABLE');
    if (result.count > DUPLICATE_SHORTLIST_LIMITS.candidatePool) {
      throw new Error('DUPLICATE_CANDIDATE_POOL_LIMIT_EXCEEDED');
    }
    return z.array(duplicateCandidateRowSchema)
      .max(DUPLICATE_SHORTLIST_LIMITS.candidatePool)
      .parse(result.data ?? []);
  }

  async loadPosterAssets(projectId: string, privateBucket: string): Promise<AssistiveAssetRow[]> {
    const result = await this.client.from('media_assets')
      .select('id,asset_type,file_name,storage_bucket,storage_path,mime_type,file_size_bytes,created_at')
      .eq('project_id', projectId)
      .eq('storage_bucket', privateBucket)
      .in('asset_type', ['poster_pdf', 'poster_image'])
      .order('created_at', { ascending: false })
      .limit(2);
    if (result.error) throw new Error('ASSISTIVE_MEDIA_READ_FAILED');
    return z.array(assetRowSchema).max(2).parse(result.data ?? []);
  }

  async download(bucket: string, path: string): Promise<Buffer> {
    const result = await this.client.storage.from(bucket).download(path);
    if (result.error || result.data === null) throw new Error('ASSISTIVE_MEDIA_DOWNLOAD_FAILED');
    return Buffer.from(await result.data.arrayBuffer());
  }
}
