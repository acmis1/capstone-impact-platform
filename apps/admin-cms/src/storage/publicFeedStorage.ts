import 'server-only';
import { createHash } from 'crypto';
import { createSupabaseAdminClient } from '../lib/supabase/admin';
import { getServerEnv } from '../lib/env';

/**
 * Uploads the compiled approved public JSON feed to the staging public-feeds storage bucket.
 */
export async function uploadPublicFeedToStorage(params: {
  feed: unknown[];
  feedFileName?: string;
}): Promise<{
  publicUrl: string;
  storagePath: string;
  recordCount: number;
  feedHash: string;
}> {
  const env = getServerEnv();
  const supabase = createSupabaseAdminClient();

  const bucket = env.SUPABASE_PUBLIC_FEEDS_BUCKET;
  const fileName = params.feedFileName || env.SUPABASE_PUBLIC_FEED_FILE;

  const content = JSON.stringify(params.feed, null, 2);
  
  // 1. Generate SHA-256 hash of feed content
  const feedHash = createHash('sha256').update(content).digest('hex');

  console.log(`Uploading feed to bucket [${bucket}] as [${fileName}]...`);

  // 2. Upload file to Supabase storage bucket
  const { error } = await supabase.storage
    .from(bucket)
    .upload(fileName, Buffer.from(content), {
      contentType: 'application/json',
      upsert: true
    });

  if (error) {
    throw new Error(`Failed to upload public feed to Supabase Storage: ${error.message}`);
  }

  // 3. Retrieve public URL
  const { data } = supabase.storage
    .from(bucket)
    .getPublicUrl(fileName);

  if (!data || !data.publicUrl) {
    throw new Error('Failed to retrieve public URL from Supabase Storage.');
  }

  return {
    publicUrl: data.publicUrl,
    storagePath: `${bucket}/${fileName}`,
    recordCount: params.feed.length,
    feedHash
  };
}
