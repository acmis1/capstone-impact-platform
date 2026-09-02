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
    missingMedicalDronePdfList?: boolean;
  } = {}) {
    const bucketsMap = new Map<
      string,
      { name: string; public: boolean; file_size_limit: number; allowed_mime_types: string[] }
    >();

    const uploads: Array<{ bucket: string; path: string; contentType: string }> = [];
    const listRequests: Array<{ bucket: string; path: string; search?: string }> = [];
    const objects = new Map<string, { name: string }>();

    const client = {
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
            upload: vi.fn().mockImplementation(async (storagePath: string, _content: Buffer, options: { contentType: string }) => {
              if (bucketName === 'project-public-assets' && overrides.uploadPublicError) {
                return { error: new Error('Storage write failed') };
              }
              if (storagePath === '2026/hydrogrid/poster.png' && overrides.uploadPrivateError) {
                return { error: new Error('Storage write failed') };
              }
              uploads.push({ bucket: bucketName, path: storagePath, contentType: options.contentType });
              objects.set(`${bucketName}:${storagePath}`, { name: storagePath.split('/').at(-1)! });
              return { error: null };
            }),
            list: vi.fn().mockImplementation(async (storagePath: string, options: { search?: string }) => {
              listRequests.push({ bucket: bucketName, path: storagePath, search: options.search });
              if (bucketName === 'project-public-assets' && overrides.missingPublicList) {
                return { data: [], error: null };
              }
              if (
                storagePath === 'drafts/2026-medical-drone/poster_pdf' &&
                overrides.missingMedicalDronePdfList
              ) {
                return { data: [], error: null };
              }
              const prefix = `${bucketName}:${storagePath}/`;
              return {
                data: Array.from(objects)
                  .filter(([key, object]) => key.startsWith(prefix) && (!options.search || object.name === options.search))
                  .map(([, object]) => object),
                error: null,
              };
            }),
          };
        }),
      },
    } as unknown as SupabaseClient;

    return { client, uploads, listRequests };
  }

  it('3. Worker function seedLocalSupabaseFixturesWorker reconciles buckets and uploads fixtures idempotently', async () => {
    const mock = createMockSupabaseClient();
    const res1 = await seedLocalSupabaseFixturesWorker(mock.client);
    expect(res1.bucketsVerified.length).toBe(3);
    expect(res1.fixturesUploaded).toEqual([
      'project-public-assets:2026/traffic-engine/poster.png',
      'project-drafts-private:2026/hydrogrid/poster.png',
      'project-drafts-private:drafts/2026-medical-drone/poster_image/poster.png',
      'project-drafts-private:drafts/2026-medical-drone/poster_pdf/poster.pdf',
    ]);
    expect(mock.uploads).toEqual([
      { bucket: 'project-public-assets', path: '2026/traffic-engine/poster.png', contentType: 'image/png' },
      { bucket: 'project-drafts-private', path: '2026/hydrogrid/poster.png', contentType: 'image/png' },
      { bucket: 'project-drafts-private', path: 'drafts/2026-medical-drone/poster_image/poster.png', contentType: 'image/png' },
      { bucket: 'project-drafts-private', path: 'drafts/2026-medical-drone/poster_pdf/poster.pdf', contentType: 'application/pdf' },
    ]);
    expect(mock.listRequests).toEqual([
      { bucket: 'project-public-assets', path: '2026/traffic-engine', search: 'poster.png' },
      { bucket: 'project-drafts-private', path: '2026/hydrogrid', search: 'poster.png' },
      { bucket: 'project-drafts-private', path: 'drafts/2026-medical-drone/poster_image', search: 'poster.png' },
      { bucket: 'project-drafts-private', path: 'drafts/2026-medical-drone/poster_pdf', search: 'poster.pdf' },
    ]);

    // Second execution remains idempotent
    const res2 = await seedLocalSupabaseFixturesWorker(mock.client);
    expect(res2.bucketsVerified.length).toBe(3);
    expect(res2.fixturesUploaded).toEqual(res1.fixturesUploaded);
  });

  it('4. Worker function fails with generic error when public fixture upload fails', async () => {
    const mock = createMockSupabaseClient({ uploadPublicError: true });
    await expect(seedLocalSupabaseFixturesWorker(mock.client)).rejects.toThrow(
      'Failed to upload public poster fixture.'
    );
  });

  it('5. Worker function fails with generic error when private fixture upload fails', async () => {
    const mock = createMockSupabaseClient({ uploadPrivateError: true });
    await expect(seedLocalSupabaseFixturesWorker(mock.client)).rejects.toThrow(
      'Failed to upload private draft fixture.'
    );
  });

  it('6. Worker function fails with generic error when post-upload object verification fails', async () => {
    const mock = createMockSupabaseClient({ missingPublicList: true });
    await expect(seedLocalSupabaseFixturesWorker(mock.client)).rejects.toThrow(
      'Verification failed: Uploaded public fixture object missing.'
    );
  });

  it('7. Worker function fails with a generic error when Medical Drone PDF verification fails', async () => {
    const mock = createMockSupabaseClient({ missingMedicalDronePdfList: true });
    await expect(seedLocalSupabaseFixturesWorker(mock.client)).rejects.toThrow(
      'Verification failed: Uploaded Medical Drone private poster PDF fixture object missing.'
    );
  });
});
