import { getServerEnv } from '../env';

/**
 * Returns storage buckets configuration resolved from secure server variables.
 * Designed to prevent direct object imports from evaluating undefined keys during compile.
 */
export function getStagingBuckets() {
  const serverEnv = getServerEnv();
  return {
    DRAFT_PRIVATE: serverEnv.SUPABASE_DRAFT_BUCKET,
    PUBLIC_ASSETS: serverEnv.SUPABASE_PUBLIC_ASSETS_BUCKET,
    PUBLIC_FEEDS: serverEnv.SUPABASE_PUBLIC_FEEDS_BUCKET,
    FEED_FILENAME: serverEnv.SUPABASE_PUBLIC_FEED_FILE,
  };
}
