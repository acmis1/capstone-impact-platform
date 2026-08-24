import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { getServerEnv } from '../lib/env';
import { serializePublicFeedArtifact } from '../feed/serializePublicFeedArtifact';

/**
 * Uploads the compiled published-only public JSON feed to the staging public-feeds storage bucket.
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
  const supabase = createSupabaseAdminClientCore();

  const bucket = env.SUPABASE_PUBLIC_FEEDS_BUCKET;
  const fileName = params.feedFileName || env.SUPABASE_PUBLIC_FEED_FILE;

  const { content, feedHash, recordCount } = serializePublicFeedArtifact(params.feed);

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
    recordCount,
    feedHash
  };
}

/**
 * Reads the exact bytes currently stored as the canonical public feed.
 *
 * null means no canonical object currently exists.
 */
export async function downloadCanonicalPublicFeed():
  Promise<Buffer | null> {
  const env = getServerEnv();
  const supabase =
    createSupabaseAdminClientCore();

  const { data, error } =
    await supabase.storage
      .from(
        env.SUPABASE_PUBLIC_FEEDS_BUCKET,
      )
      .download(
        env.SUPABASE_PUBLIC_FEED_FILE,
      );

  if (error) {
    const message =
      error.message?.toLowerCase() ?? '';

    if (
      message.includes('not found') ||
      message.includes('does not exist')
    ) {
      return null;
    }

    throw new Error(
      'Canonical public feed could not be read.',
    );
  }

  if (!data) {
    return null;
  }

  return Buffer.from(
    await data.arrayBuffer(),
  );
}

/**
 * Restores already-serialized canonical feed bytes exactly as verified.
 *
 * Rollback must not rebuild or normalize the selected historical artifact
 * at write time because exact-byte restoration is part of its integrity
 * guarantee.
 */
export async function uploadExactCanonicalPublicFeed(
  content: string,
): Promise<void> {
  const env = getServerEnv();
  const supabase =
    createSupabaseAdminClientCore();

  const { error } =
    await supabase.storage
      .from(
        env.SUPABASE_PUBLIC_FEEDS_BUCKET,
      )
      .upload(
        env.SUPABASE_PUBLIC_FEED_FILE,

        Buffer.from(content, 'utf8'),

        {
          contentType:
            'application/json',

          upsert: true,
        },
      );

  if (error) {
    throw new Error(
      'Canonical public feed write failed.',
    );
  }
}
