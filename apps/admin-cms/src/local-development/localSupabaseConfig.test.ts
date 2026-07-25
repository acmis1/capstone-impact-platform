import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Local Supabase Configuration & Migration Integrity Tests', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const migrationsDir = path.resolve(repoRoot, 'infra/supabase/migrations');
  const configPath = path.resolve(repoRoot, 'infra/supabase/config.toml');
  const seedPath = path.resolve(repoRoot, 'infra/supabase/seed.sql');

  it('1. Exactly 6 timestamped migration files exist in explicitly sorted ascending order', () => {
    const rawFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(rawFiles.length).toBe(6);

    // Sort explicitly to not rely on OS directory enumeration order
    const files = [...rawFiles].sort((a, b) => a.localeCompare(b));

    // Verify 14-digit timestamp format
    const timestampRegex = /^\d{14}_.+\.sql$/;
    for (const f of files) {
      expect(f).toMatch(timestampRegex);
    }

    // Verify strict ascending timestamps
    const timestamps = files.map((f) => f.substring(0, 14));
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] > timestamps[i - 1]).toBe(true);
    }
  });

  it('2. No un-timestamped legacy 0001-0006 filenames remain', () => {
    const files = fs.readdirSync(migrationsDir);
    for (const f of files) {
      expect(f.startsWith('0001_')).toBe(false);
      expect(f.startsWith('0002_')).toBe(false);
      expect(f.startsWith('0003_')).toBe(false);
      expect(f.startsWith('0004_')).toBe(false);
      expect(f.startsWith('0005_')).toBe(false);
      expect(f.startsWith('0006_')).toBe(false);
    }
  });

  it('3. SQL fingerprint checks prove all schema, RLS, triggers, grants, and functions are preserved', () => {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));
    const combinedSql = files.map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8')).join('\n');

    // 13 expected tables
    const expectedTables = [
      'programs',
      'disciplines',
      'industry_categories',
      'admin_users',
      'user_roles',
      'import_batches',
      'projects',
      'project_disciplines',
      'project_industry_categories',
      'media_assets',
      'validation_flags',
      'approval_records',
      'published_snapshots',
    ];

    for (const table of expectedTables) {
      expect(combinedSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(combinedSql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }

    // Trigger check
    expect(combinedSql).toContain('CREATE OR REPLACE FUNCTION update_updated_at_column');
    expect(combinedSql).toContain('CREATE TRIGGER update_projects_updated_at');

    // Restrictive internal policies check
    expect(combinedSql).toContain('CREATE POLICY admin_all_projects');
    expect(combinedSql).toContain('CREATE POLICY admin_all_admin_users');

    // Explicit grants check
    expect(combinedSql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE');
    expect(combinedSql).toContain('public.projects,');
    expect(combinedSql).toContain('TO service_role;');

    // Bootstrap function & final btrim correction check
    expect(combinedSql).toContain('CREATE OR REPLACE FUNCTION public.bootstrap_initial_admin');

    const fixMigrationFile = files.find((f) => f.includes('fix_initial_admin_bootstrap_runtime'));
    expect(fixMigrationFile).toBeDefined();
    const fixSql = fs.readFileSync(path.join(migrationsDir, fixMigrationFile!), 'utf8');
    expect(fixSql).toContain('pg_catalog.btrim');
    expect(fixSql).not.toContain('pg_catalog.trim(');
  });

  it('4. config.toml contains required local Auth (both auth and auth.email enable_signup = false) and Storage bucket definitions', () => {
    expect(fs.existsSync(configPath)).toBe(true);
    const content = fs.readFileSync(configPath, 'utf8');

    // Parse [auth] and [auth.email] sections independently
    const authSectionMatch = content.match(/\[auth\]\s*\n([\s\S]*?)(?=\n\s*\[|$)/);
    const authEmailSectionMatch = content.match(/\[auth\.email\]\s*\n([\s\S]*?)(?=\n\s*\[|$)/);

    expect(authSectionMatch).not.toBeNull();
    expect(authEmailSectionMatch).not.toBeNull();

    const authSection = authSectionMatch![1];
    const authEmailSection = authEmailSectionMatch![1];

    // Assert auth.enable_signup is false and no contradictory true value
    expect(authSection).toContain('enable_signup = false');
    expect(authSection).not.toContain('enable_signup = true');

    // Assert auth.email.enable_signup is false and no contradictory true value
    expect(authEmailSection).toContain('enable_signup = false');
    expect(authEmailSection).not.toContain('enable_signup = true');

    // Redirect URLs assertions
    expect(authSection).toContain('site_url = "http://localhost:3000"');
    expect(authSection).toContain('"http://localhost:3000/auth/confirm"');
    expect(authSection).toContain('"http://localhost:3000/auth/confirm/accept"');
    expect(authSection).toContain('"http://localhost:3000/auth/set-password"');
    expect(authSection).not.toContain('/auth/callback');

    // Storage buckets
    expect(content).toContain('[storage.buckets.project-drafts-private]');
    expect(content).toContain('[storage.buckets.project-public-assets]');
    expect(content).toContain('[storage.buckets.public-feeds]');

    expect(content).toContain('public = false');
    expect(content).toContain('public = true');

    // Seed configuration
    expect(content).toContain('sql_paths = ["./seed.sql"]');
  });

  it('5. seed.sql contains no auth.users inserts, passwords, hosted URLs or secrets', () => {
    expect(fs.existsSync(seedPath)).toBe(true);
    const content = fs.readFileSync(seedPath, 'utf8');

    expect(content).not.toContain('auth.users');
    expect(content).not.toContain('INSERT INTO auth.users');
    expect(content).not.toContain('supabase.co');
    expect(content).not.toContain('sb_secret_');
    expect(content).not.toContain('sb_publishable_');
    expect(content).not.toContain('password');
  });
});
