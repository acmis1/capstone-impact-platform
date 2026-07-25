import { describe, it, expect, vi } from 'vitest';
import {
  seedLocalSupabaseFixtures,
  seedLocalSupabaseFixturesWorker,
  EXPECTED_BUCKETS,
} from './localSupabaseFixtures';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('Local Supabase Fixtures Unit Tests', () => {
  it('1. Exactly 3 local storage buckets are defined with exact visibility and size limits', () => {
    expect(EXPECTED_BUCKETS.length).toBe(3);
    const bucketNames = EXPECTED_BUCKETS.map((b) => b.name);
    expect(bucketNames).toEqual(['project-drafts-private', 'project-public-assets', 'public-feeds']);

    const drafts = EXPECTED_BUCKETS.find((b) => b.name === 'project-drafts-private');
    expect(drafts?.isPublic).toBe(false);
    expect(drafts?.fileSizeLimit).toBe(20 * 1024 * 1024);

    const publicAssets = EXPECTED_BUCKETS.find((b) => b.name === 'project-public-assets');
    expect(publicAssets?.isPublic).toBe(true);
    expect(publicAssets?.fileSizeLimit).toBe(20 * 1024 * 1024);

    const publicFeeds = EXPECTED_BUCKETS.find((b) => b.name === 'public-feeds');
    expect(publicFeeds?.isPublic).toBe(true);
    expect(publicFeeds?.fileSizeLimit).toBe(10 * 1024 * 1024);
  });

  it('2. Public entry point seedLocalSupabaseFixtures rejects non-loopback Supabase URL with generic error', async () => {
    const sensitiveUrl = 'https://abcdefghijkl.supabase.co';
    const secretKey = 'sb_secret_key_12345';
    try {
      await seedLocalSupabaseFixtures({
        supabaseUrl: sensitiveUrl,
        serviceRoleKey: secretKey,
      });
      expect.fail('Should have thrown error');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toBe('Non-loopback Supabase endpoint rejected.');
      expect(msg).not.toContain(sensitiveUrl);
      expect(msg).not.toContain(secretKey);
      expect(msg).not.toContain('abcdefghijkl');
    }
  });

  function createMockSupabaseClient(overrides: {
    uploadPublicError?: boolean;
    uploadPrivateError?: boolean;
    missingPublicList?: boolean;
  } = {}) {
    const bucketsMap = new Map<
      string,
      { name: string; public: boolean; file_size_limit: number; allowed_mime_types: string[] }
    >();

    return {
      storage: {
        listBuckets: vi.fn().mockImplementation(async () => {
          return { data: Array.from(bucketsMap.values()), error: null };
        }),
        createBucket: vi.fn().mockImplementation(
          async (name: string, opts: { public: boolean; fileSizeLimit: number; allowedMimeTypes: string[] }) => {
            const item = {
              name,
              public: opts.public,
              file_size_limit: opts.fileSizeLimit,
              allowed_mime_types: opts.allowedMimeTypes,
            };
            bucketsMap.set(name, item);
            return { error: null };
          }
        ),
        updateBucket: vi.fn().mockImplementation(
          async (name: string, opts: { public: boolean; fileSizeLimit: number; allowedMimeTypes: string[] }) => {
            const existing = bucketsMap.get(name) || {
              name,
              public: opts.public,
              file_size_limit: opts.fileSizeLimit,
              allowed_mime_types: opts.allowedMimeTypes,
            };
            const item = {
              ...existing,
              public: opts.public,
              file_size_limit: opts.fileSizeLimit,
              allowed_mime_types: opts.allowedMimeTypes,
            };
            bucketsMap.set(name, item);
            return { error: null };
          }
        ),
        getBucket: vi.fn().mockImplementation(async (name: string) => {
          const item = bucketsMap.get(name);
          return item ? { data: item, error: null } : { data: null, error: new Error('Bucket not found') };
        }),
        from: vi.fn().mockImplementation((bucketName: string) => {
          return {
            upload: vi.fn().mockImplementation(async () => {
              if (bucketName === 'project-public-assets' && overrides.uploadPublicError) {
                return { error: new Error('Storage write failed') };
              }
              if (bucketName === 'project-drafts-private' && overrides.uploadPrivateError) {
                return { error: new Error('Storage write failed') };
              }
              return { error: null };
            }),
            list: vi.fn().mockImplementation(async () => {
              if (bucketName === 'project-public-assets' && overrides.missingPublicList) {
                return { data: [], error: null };
              }
              return { data: [{ name: 'poster.png' }], error: null };
            }),
          };
        }),
      },
    } as unknown as SupabaseClient;
  }

  it('3. Worker function seedLocalSupabaseFixturesWorker reconciles buckets and uploads fixtures idempotently', async () => {
    const mockClient = createMockSupabaseClient();
    const res1 = await seedLocalSupabaseFixturesWorker(mockClient);
    expect(res1.bucketsVerified.length).toBe(3);
    expect(res1.fixturesUploaded.length).toBe(2);

    // Second execution remains idempotent
    const res2 = await seedLocalSupabaseFixturesWorker(mockClient);
    expect(res2.bucketsVerified.length).toBe(3);
    expect(res2.fixturesUploaded.length).toBe(2);
  });

  it('4. Worker function fails with generic error when public fixture upload fails', async () => {
    const mockClient = createMockSupabaseClient({ uploadPublicError: true });
    await expect(seedLocalSupabaseFixturesWorker(mockClient)).rejects.toThrow(
      'Failed to upload public poster fixture.'
    );
  });

  it('5. Worker function fails with generic error when private fixture upload fails', async () => {
    const mockClient = createMockSupabaseClient({ uploadPrivateError: true });
    await expect(seedLocalSupabaseFixturesWorker(mockClient)).rejects.toThrow(
      'Failed to upload private draft fixture.'
    );
  });

  it('6. Worker function fails with generic error when post-upload object verification fails', async () => {
    const mockClient = createMockSupabaseClient({ missingPublicList: true });
    await expect(seedLocalSupabaseFixturesWorker(mockClient)).rejects.toThrow(
      'Verification failed: Uploaded public fixture object missing.'
    );
  });
});
