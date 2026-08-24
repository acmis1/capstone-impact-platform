import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { createPublicFeedArtifact } from '../feed/publicFeedArtifact';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { activatePublicFeedHistory } from '../projects/publicFeedHistoryService';
import { inspectPublicFeedHead } from '../projects/publicFeedWriterCoordinator';
import { SupabaseParticipantPreviewRepositoryCore } from '../repositories/SupabaseParticipantPreviewRepositoryCore';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';

/**
 * Shared harness for the public-feed runtimes that drive the deployment ledger.
 *
 * Activating the ledger head is a governed, irreversible, singleton operation, and immutable
 * version history deliberately prevents deleting any project or audit record it references. A
 * runtime that exercises it therefore cannot restore a shared stack to its prior state, so every
 * such runtime requires a verifier-owned throwaway stack whose disposal is the cleanup.
 */

export const PUBLIC_FEED_BUCKET = 'public-feeds';
export const PUBLIC_FEED_PATH = 'runtime/issue-186-public-feed.json';
export const PRIVATE_BUCKET = 'project-drafts-private';
export const PUBLIC_ASSETS_BUCKET = 'project-public-assets';
export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
export const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF', 'ascii');

export interface RuntimeFixture {
  id: string;
  publicId: string;
  confirmedPreviewId?: string;
  confirmedAt?: string;
}

export interface PublicFeedRuntimeHarness {
  db: SupabaseClient;
  apiUrl: string;
  adminId: string;
  reviewerId: string;
  projects: SupabaseProjectRepositoryCore;
  previews: SupabaseParticipantPreviewRepositoryCore;
  psql(sql: string): string;
  quoted(value: string): string;
  createProject(publicId: string, status?: string): Promise<RuntimeFixture>;
  makeReady(publicId: string, prefix: string): Promise<RuntimeFixture>;
  ensureActiveHead(): Promise<void>;
  storedFeed(): Promise<Buffer | null>;
  count(table: string, column: string, value: string): Promise<number>;
}

const ADMIN_ID = '18600000-0000-4000-8000-000000000011';
const REVIEWER_ID = '18600000-0000-4000-8000-000000000012';

export function requireDisposableRuntime(): { workdir: string; projectId: string } {
  const workdir = process.env.CAPSTONE_VERIFY_SUPABASE_WORKDIR?.trim();
  const projectId = process.env.CAPSTONE_VERIFY_SUPABASE_PROJECT_ID?.trim();
  assert.equal(process.env.CAPSTONE_VERIFY_DISPOSABLE, '1', 'Disposable verifier acknowledgement is required.');
  assert.ok(workdir && path.isAbsolute(workdir), 'A disposable absolute Supabase workdir is required.');
  assert.ok(projectId && /^capstone-pp1-[a-z0-9-]+$/.test(projectId), 'A verifier-only project ID is required.');
  return { workdir, projectId };
}

export async function createPublicFeedRuntimeHarness(): Promise<PublicFeedRuntimeHarness> {
  const { workdir, projectId } = requireDisposableRuntime();
  const repositoryRoot = path.resolve(__dirname, '../../../..');
  const cli = path.resolve(repositoryRoot, 'node_modules/supabase/dist/supabase.js');
  const raw = execFileSync(process.execPath, [cli, 'status', '--workdir', workdir, '-o', 'env'], {
    cwd: repositoryRoot, encoding: 'utf8', env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  const local = parseSupabaseCliEnv(raw);
  assert.ok(local.API_URL && local.SERVICE_ROLE_KEY, 'Disposable Supabase credentials unavailable.');
  assert.equal(isLoopbackUrl(local.API_URL!), true, 'The verifier refused a non-loopback Supabase endpoint.');

  const db = createClient(local.API_URL!, local.SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const projects = new SupabaseProjectRepositoryCore(db);
  const previews = new SupabaseParticipantPreviewRepositoryCore(db);

  const psql = (sql: string): string => {
    const containers = execFileSync('docker', [
      'ps', '--filter', `label=com.supabase.cli.project=${projectId}`,
      '--filter', 'name=supabase_db_', '--format', '{{.Names}}',
    ], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
    assert.equal(containers.length, 1, 'Expected exactly one verifier-owned database container.');
    return execFileSync('docker', [
      'exec', containers[0], 'psql', '-U', 'postgres', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  };
  const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

  psql(`
    INSERT INTO public.admin_users(id,email,full_name) VALUES
      (${quoted(ADMIN_ID)}::uuid,'ledger-runtime-admin@example.invalid','Ledger Runtime Admin'),
      (${quoted(REVIEWER_ID)}::uuid,'ledger-runtime-reviewer@example.invalid','Ledger Runtime Reviewer')
      ON CONFLICT (id) DO UPDATE SET full_name=EXCLUDED.full_name;
    INSERT INTO public.user_roles(user_id,role) VALUES
      (${quoted(ADMIN_ID)}::uuid,'admin'), (${quoted(REVIEWER_ID)}::uuid,'reviewer')
      ON CONFLICT (user_id,role) DO NOTHING;
  `);

  const storedFeed = async (): Promise<Buffer | null> => {
    const result = await db.storage.from(PUBLIC_FEED_BUCKET).download(PUBLIC_FEED_PATH);
    if (result.error) {
      if (/not found|does not exist|404/i.test(result.error.message)) return null;
      throw result.error;
    }
    return result.data ? Buffer.from(await result.data.arrayBuffer()) : null;
  };

  const createProject = async (publicId: string, status = 'approved'): Promise<RuntimeFixture> => {
    const result = await db.from('projects').insert({
      public_id: publicId, title: `Synthetic ${publicId}`, slug: publicId,
      summary: 'Synthetic public summary.', background: 'Synthetic public background.',
      solution: 'Synthetic public solution.', year: 2026,
      program_name: 'Bachelor of Software Engineering', study_program: 'Bachelor of Software Engineering',
      discipline: 'Software Engineering', industry: 'Technology', industry_partner: 'Synthetic Partner',
      academic_supervisor: 'Synthetic Supervisor', group_name: 'Synthetic Group',
      team_members: ['Synthetic Member'], poster_url: '', poster_pdf_url: '', snapshots: [],
      poster_text_public: 'Synthetic poster text.', accessibility_text_public: 'Synthetic accessible text.',
      external_links: [], citations: [], layout_config: {}, status,
    }).select('id,public_id').single();
    assert.equal(result.error, null, result.error?.message);
    return { id: String(result.data!.id), publicId: String(result.data!.public_id) };
  };

  const makeReady = async (publicId: string, prefix: string): Promise<RuntimeFixture> => {
    const fixture = await createProject(publicId);
    for (const asset of [
      { type: 'poster_image', name: 'poster.png', mime: 'image/png', bytes: PNG_BYTES },
      { type: 'poster_pdf', name: 'poster.pdf', mime: 'application/pdf', bytes: PDF_BYTES },
    ]) {
      const storagePath = `${prefix}/${publicId}/${asset.type}/${asset.name}`;
      const uploaded = await db.storage.from(PRIVATE_BUCKET).upload(storagePath, asset.bytes, {
        contentType: asset.mime, upsert: false,
      });
      assert.equal(uploaded.error, null, uploaded.error?.message);
      const media = await db.from('media_assets').insert({
        project_id: fixture.id, asset_type: asset.type, file_name: asset.name,
        storage_bucket: PRIVATE_BUCKET, storage_path: storagePath, public_url: null,
        mime_type: asset.mime, file_size_bytes: asset.bytes.length, is_public_approved: false,
      });
      assert.equal(media.error, null, media.error?.message);
    }
    const generated = await previews.generatePreview({
      publicId, adminId: ADMIN_ID,
      tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
      privateBucket: PRIVATE_BUCKET,
    });
    const token = await db.from('participant_previews').select('token_hash').eq('id', generated.previewId).single();
    assert.equal(token.error, null, token.error?.message);
    assert.ok(await previews.confirmPreview(String(token.data!.token_hash)), 'Synthetic participant confirmation failed.');
    const readiness = await previews.getPublicationReadiness({
      publicId, adminId: ADMIN_ID, privateBucket: PRIVATE_BUCKET,
    });
    assert.ok(readiness.ready && readiness.confirmedPreviewId && readiness.confirmedAt, 'Synthetic readiness unavailable.');
    fixture.confirmedPreviewId = readiness.confirmedPreviewId!;
    fixture.confirmedAt = readiness.confirmedAt!;
    return fixture;
  };

  /** Activates the governed singleton head once, against the exact current lifecycle projection. */
  const ensureActiveHead = async (): Promise<void> => {
    const inspected = await inspectPublicFeedHead(db, PUBLIC_FEED_BUCKET, PUBLIC_FEED_PATH);
    if (inspected.head) return;
    const projection = createPublicFeedArtifact(compilePublicFeed(await projects.listProjects()));
    const uploaded = await db.storage.from(PUBLIC_FEED_BUCKET).upload(PUBLIC_FEED_PATH, projection.bytes, {
      contentType: 'application/json', upsert: true,
    });
    assert.equal(uploaded.error, null, uploaded.error?.message);
    const activation = await activatePublicFeedHistory({
      supabase: db, supabaseUrl: local.API_URL!, adminId: ADMIN_ID, permissions: ['projects.publish'],
      feedBucket: PUBLIC_FEED_BUCKET, feedPath: PUBLIC_FEED_PATH,
      listProjects: () => projects.listProjects(),
      assertActivationEnvironment: () => undefined,
    });
    assert.ok(['COMPLETED', 'ALREADY_ACTIVE'].includes(activation.resultCode), JSON.stringify(activation));
  };

  return {
    db, apiUrl: local.API_URL!, adminId: ADMIN_ID, reviewerId: REVIEWER_ID, projects, previews,
    psql, quoted, createProject, makeReady, ensureActiveHead, storedFeed,
    count: async (table, column, value) =>
      (await db.from(table).select('id', { count: 'exact', head: true }).eq(column, value)).count ?? 0,
  };
}

export function createScenarioRunner(): {
  scenario(index: number, name: string, body: () => Promise<void>): Promise<void>;
  passed(): number;
} {
  let count = 0;
  return {
    scenario: async (index, name, body) => {
      console.log(`Scenario ${index}: ${name}`);
      await body();
      count += 1;
      console.log(`PASS: Scenario ${index}`);
    },
    passed: () => count,
  };
}
