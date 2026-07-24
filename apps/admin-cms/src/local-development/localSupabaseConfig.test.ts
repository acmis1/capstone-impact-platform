import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Local Supabase Configuration & Migration Integrity Tests', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const migrationsDir = path.resolve(repoRoot, 'infra/supabase/migrations');
  const configPath = path.resolve(repoRoot, 'infra/supabase/config.toml');
  const seedPath = path.resolve(repoRoot, 'infra/supabase/seed.sql');

  it('1. Exactly 6 timestamped migration files exist in ascending order', () => {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBe(6);

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

  it('3. Migration 0006 equivalent file contains btrim runtime fix', () => {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    const fixMigrationFile = files.find((f) => f.includes('fix_initial_admin_bootstrap_runtime'));
    expect(fixMigrationFile).toBeDefined();

    const content = fs.readFileSync(path.join(migrationsDir, fixMigrationFile!), 'utf8');
    expect(content).toContain('pg_catalog.btrim');
    expect(content).not.toContain('pg_catalog.trim(');
  });

  it('4. config.toml contains required local Auth and Storage bucket definitions', () => {
    expect(fs.existsSync(configPath)).toBe(true);
    const content = fs.readFileSync(configPath, 'utf8');

    // Auth configuration
    expect(content).toContain('site_url = "http://localhost:3000"');
    expect(content).toContain('enable_signup = false');

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
