import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { isLoopbackUrl, parseSupabaseCliEnv } from './localEnvironmentFile';

export interface BucketSpec {
  name: string;
  isPublic: boolean;
  fileSizeLimit: number; // in bytes
  allowedMimeTypes: string[];
}

export const EXPECTED_BUCKETS: BucketSpec[] = [
  {
    name: 'project-drafts-private',
    isPublic: false,
    fileSizeLimit: 20 * 1024 * 1024, // 20 MB
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
  },
  {
    name: 'project-public-assets',
    isPublic: true,
    fileSizeLimit: 20 * 1024 * 1024, // 20 MB
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
  },
  {
    name: 'public-feeds',
    isPublic: true,
    fileSizeLimit: 10 * 1024 * 1024, // 10 MB
    allowedMimeTypes: ['application/json'],
  },
];

export interface SeedFixturesOptions {
  supabaseUrl?: string;
  serviceRoleKey?: string;
  cliOutput?: string;
  customClient?: SupabaseClient;
}

/**
 * Ensures local storage buckets exist with expected visibility and uploads synthetic fixtures safely.
 * Never imports server-only environment modules or contacts hosted endpoints.
 */
export async function seedLocalSupabaseFixtures(options: SeedFixturesOptions = {}): Promise<{
  bucketsVerified: string[];
  fixturesUploaded: string[];
}> {
  let apiUrl = options.supabaseUrl;
  let serviceKey = options.serviceRoleKey;

  if (!options.customClient && (!apiUrl || !serviceKey)) {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const workdir = path.resolve(repoRoot, 'infra');
    const cliPath = path.resolve(repoRoot, 'node_modules/.bin/supabase');
    const cmd = `"${cliPath}" status --workdir "${workdir}" -o env`;
    try {
      const rawEnv = options.cliOutput || execSync(cmd, { encoding: 'utf8', cwd: repoRoot });
      const parsed = parseSupabaseCliEnv(rawEnv);
      apiUrl = parsed.API_URL || apiUrl;
      serviceKey = parsed.SERVICE_ROLE_KEY || serviceKey;
    } catch {
      throw new Error('Local Supabase CLI status query failed.');
    }
  }

  if (!options.customClient) {
    if (!apiUrl || !isLoopbackUrl(apiUrl)) {
      throw new Error('Non-loopback Supabase endpoint rejected.');
    }
    if (!serviceKey) {
      throw new Error('Local service-role administrative key required.');
    }
  }

  const client =
    options.customClient ||
    createClient(apiUrl!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

  const bucketsVerified: string[] = [];
  const fixturesUploaded: string[] = [];

  // 1. Verify/create storage buckets
  const { data: existingBuckets, error: listErr } = await client.storage.listBuckets();
  if (listErr) {
    throw new Error('Failed to list local storage buckets.');
  }

  const existingMap = new Map((existingBuckets || []).map((b) => [b.name, b]));

  for (const spec of EXPECTED_BUCKETS) {
    const existing = existingMap.get(spec.name);
    if (!existing) {
      const { error: createErr } = await client.storage.createBucket(spec.name, {
        public: spec.isPublic,
        fileSizeLimit: spec.fileSizeLimit,
        allowedMimeTypes: spec.allowedMimeTypes,
      });
      if (createErr) {
        throw new Error(`Failed to create bucket [${spec.name}].`);
      }
    } else if (existing.public !== spec.isPublic) {
      const { error: updateErr } = await client.storage.updateBucket(spec.name, {
        public: spec.isPublic,
        fileSizeLimit: spec.fileSizeLimit,
        allowedMimeTypes: spec.allowedMimeTypes,
      });
      if (updateErr) {
        throw new Error(`Failed to update bucket visibility for [${spec.name}].`);
      }
    }
    bucketsVerified.push(spec.name);
  }

  // 2. Upload synthetic local fixture files
  const syntheticPosterBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );

  // Upload synthetic poster to public assets
  const publicPath = '2026/traffic-engine/poster.png';
  const { error: uploadPublicErr } = await client.storage
    .from('project-public-assets')
    .upload(publicPath, syntheticPosterBuffer, { contentType: 'image/png', upsert: true });

  if (!uploadPublicErr) {
    fixturesUploaded.push(`project-public-assets:${publicPath}`);
  }

  // Upload synthetic private draft poster
  const privatePath = '2026/hydrogrid/poster.png';
  const { error: uploadPrivateErr } = await client.storage
    .from('project-drafts-private')
    .upload(privatePath, syntheticPosterBuffer, { contentType: 'image/png', upsert: true });

  if (!uploadPrivateErr) {
    fixturesUploaded.push(`project-drafts-private:${privatePath}`);
  }

  return { bucketsVerified, fixturesUploaded };
}
