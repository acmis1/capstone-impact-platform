import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const projectRowSchema = z.object({
  id: z.uuid(),
  public_id: z.string().min(1).max(100),
  title: z.string().nullable(),
}).strict();

const assetRowSchema = z.object({
  id: z.uuid(),
  asset_type: z.enum(['poster_pdf', 'poster_image']),
  file_name: z.string().min(1).max(255),
  storage_bucket: z.string().min(1).max(100),
  storage_path: z.string().min(1).max(1024),
  mime_type: z.string().nullable(),
  file_size_bytes: z.number().int().positive().nullable(),
  created_at: z.string().min(1),
}).strict();

export type AssistiveProjectRow = z.infer<typeof projectRowSchema>;
export type AssistiveAssetRow = z.infer<typeof assetRowSchema>;

export interface AssistiveInputGateway {
  loadProject(projectId: string): Promise<AssistiveProjectRow | null>;
  loadPosterAssets(projectId: string, privateBucket: string): Promise<AssistiveAssetRow[]>;
  download(bucket: string, path: string): Promise<Buffer>;
}

export class SupabaseAssistiveInputRepository implements AssistiveInputGateway {
  constructor(private readonly client: SupabaseClient) {}

  async loadProject(projectId: string): Promise<AssistiveProjectRow | null> {
    const result = await this.client.from('projects')
      .select('id,public_id,title')
      .eq('id', projectId)
      .is('deleted_at', null)
      .maybeSingle();
    if (result.error) throw new Error('ASSISTIVE_PROJECT_READ_FAILED');
    return result.data === null ? null : projectRowSchema.parse(result.data);
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
