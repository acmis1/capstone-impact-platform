import { env } from '../env';

// Bucket names exported directly from evaluated environment config
export const BUCKETS = {
  /**
   * Private bucket hosting draft media assets, XLSX templates, and intermediate files.
   * Row-level security restricts read access to coordinators/reviewers only.
   */
  DRAFT_PRIVATE: env.SUPABASE_DRAFT_BUCKET,

  /**
   * Public-safe bucket hosting fully approved showcase assets (poster previews, PDFs, snapshots).
   * Assets here are fully accessible under public URLs.
   */
  PUBLIC_ASSETS: env.SUPABASE_PUBLIC_ASSETS_BUCKET,

  /**
   * Public-safe bucket hosting the compiled approved-only Capstones feed.
   */
  PUBLIC_FEEDS: env.SUPABASE_PUBLIC_FEEDS_BUCKET,

  /**
   * Stable filename compiled by the Admin/CMS (e.g. capstones-latest.json).
   * The Duda presentation layer always fetches this file from this stable path.
   */
  FEED_FILENAME: env.SUPABASE_PUBLIC_FEED_FILE,
} as const;
