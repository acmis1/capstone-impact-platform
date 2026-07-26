import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Root Staging Command Contract & Argument Forwarding Tests', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const rootPackageJsonPath = path.resolve(repoRoot, 'package.json');

  it('1. Root package.json exists and parses cleanly', () => {
    expect(fs.existsSync(rootPackageJsonPath)).toBe(true);
    const content = fs.readFileSync(rootPackageJsonPath, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.scripts).toBeDefined();
  });

  it('2. All 5 mutating root staging commands explicitly forward CLI arguments with trailing -- delimiter', () => {
    const pkg = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf8'));
    const scripts = pkg.scripts;

    const expectedMutatingMap: Record<string, { appScript: string }> = {
      'seed:admin-staging': { appScript: 'seed:staging' },
      'seed:admin-media': { appScript: 'seed:staging-media' },
      'publish:admin-feed': { appScript: 'publish:staging-feed' },
      'import:admin-package': { appScript: 'import:staging-package' },
      'link:admin-staging': { appScript: 'link:staging-admin' },
    };

    Object.entries(expectedMutatingMap).forEach(([rootCmd, config]) => {
      const scriptVal = scripts[rootCmd];
      expect(scriptVal).toBeDefined();
      expect(scriptVal).toContain(`--workspace=apps/admin-cms`);
      expect(scriptVal).toContain(`npm run ${config.appScript}`);
      expect(scriptVal.trim().endsWith('--')).toBe(true);
    });
  });

  it('3. Read-only staging commands exist and map to workspace scripts without mutation forwarding requirements', () => {
    const pkg = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf8'));
    const scripts = pkg.scripts;

    expect(scripts['check:admin-staging']).toBe('npm run check:staging-projects --workspace=apps/admin-cms');
    expect(scripts['check:admin-media']).toBe('npm run check:staging-media --workspace=apps/admin-cms');
    expect(scripts['check:admin-imports']).toBe('npm run check:import-batches --workspace=apps/admin-cms');
    expect(scripts['check:admin-auth']).toBe('npm run check:staging-auth --workspace=apps/admin-cms');
    expect(scripts['check:feed']).toBe('npm run check:sample-feed --workspace=apps/admin-cms');
  });

  it('4. Local loopback Supabase commands remain defined and unchanged', () => {
    const pkg = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf8'));
    const scripts = pkg.scripts;

    expect(scripts['supabase:start']).toBe('supabase start --workdir infra');
    expect(scripts['supabase:stop']).toBe('supabase stop --workdir infra');
    expect(scripts['supabase:reset']).toBe('supabase db reset --local --workdir infra');
    expect(scripts['supabase:seed:buckets']).toBe('npm run seed:buckets:local --workspace=apps/admin-cms --');
    expect(scripts['supabase:env:local']).toBe('npm run env:local --workspace=apps/admin-cms --');
    expect(scripts['supabase:users:local']).toBe('npm run users:local --workspace=apps/admin-cms --');
    expect(scripts['supabase:verify:local']).toBe('npm run verify:local --workspace=apps/admin-cms --');
  });

  it('5. No root script embeds secret keys, credentials, or private project hostnames', () => {
    const rawContent = fs.readFileSync(rootPackageJsonPath, 'utf8');

    expect(rawContent).not.toContain('sb_secret_');
    expect(rawContent).not.toContain('sb_publishable_');
    expect(rawContent).not.toContain('eyJhbGci');
    expect(rawContent).not.toContain('.supabase.co');
    expect(rawContent).not.toContain('password');
  });
});
