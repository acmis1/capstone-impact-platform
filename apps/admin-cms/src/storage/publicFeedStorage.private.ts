import type { SupabaseClient } from '@supabase/supabase-js';
import { MAX_PUBLIC_FEED_ARTIFACT_BYTES } from '../feed/publicFeedArtifact';

export class PublicFeedStorageBoundary {
  constructor(private readonly supabase: SupabaseClient) {}

  async readExact(bucket: string, path: string): Promise<Buffer | null> {
    const { data, error } = await this.supabase.storage.from(bucket).download(path);
    if (error) {
      if (/not found|does not exist|404/i.test(error.message || '')) return null;
      throw new Error('PUBLIC_FEED_STORAGE_READ_FAILED');
    }
    if (!data) return null;
    if (data.size > MAX_PUBLIC_FEED_ARTIFACT_BYTES) {
      throw new Error('PUBLIC_FEED_STORAGE_ARTIFACT_TOO_LARGE');
    }
    const bytes = Buffer.from(await data.arrayBuffer());
    if (bytes.byteLength > MAX_PUBLIC_FEED_ARTIFACT_BYTES) {
      throw new Error('PUBLIC_FEED_STORAGE_ARTIFACT_TOO_LARGE');
    }
    return bytes;
  }

  /** The sole production mutation primitive for the canonical feed object. */
  async writeExact(bucket: string, path: string, bytes: Buffer): Promise<void> {
    if (bytes.byteLength > MAX_PUBLIC_FEED_ARTIFACT_BYTES) {
      throw new Error('PUBLIC_FEED_STORAGE_ARTIFACT_TOO_LARGE');
    }
    const { error } = await this.supabase.storage.from(bucket).upload(path, bytes, {
      contentType: 'application/json',
      upsert: true,
    });
    if (error) throw new Error('PUBLIC_FEED_STORAGE_WRITE_FAILED');
  }

  getPublicUrl(bucket: string, path: string): string {
    const { data } = this.supabase.storage.from(bucket).getPublicUrl(path);
    if (!data?.publicUrl) throw new Error('PUBLIC_FEED_PUBLIC_URL_UNAVAILABLE');
    return data.publicUrl;
  }
}
