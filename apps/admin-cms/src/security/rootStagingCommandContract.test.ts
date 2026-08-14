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
    expect(scripts['check:admin-deployment-readiness']).toBe('npm run check:deployment-readiness --workspace=apps/admin-cms');
    expect(scripts['check:admin-staging-readiness']).toBe('npm run check:staging-readiness --workspace=apps/admin-cms');
    expect(scripts['check:feed']).toBe('npm run check:sample-feed --workspace=apps/admin-cms');
  });

  it('4. Local loopback Supabase commands use safe repository wrappers', () => {
    const pkg = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf8'));
    const scripts = pkg.scripts;

    expect(scripts['supabase:start']).toBe('tsx apps/admin-cms/src/scripts/runLocalSupabase.ts start');
    expect(scripts['supabase:stop']).toBe('tsx apps/admin-cms/src/scripts/runLocalSupabase.ts stop');
    expect(scripts['supabase:reset']).toBe('tsx apps/admin-cms/src/scripts/runLocalSupabase.ts reset');
    expect(scripts['supabase:status']).toBeUndefined();
    expect(scripts['supabase:assert-running']).toBe('tsx apps/admin-cms/src/scripts/assertSupabaseRunning.ts');
    expect(scripts['supabase:assert-stopped']).toBe('tsx apps/admin-cms/src/scripts/assertSupabaseStopped.ts');
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

  it('6. Executable source and documentation contracts correctly distinguish CAPSTONE_BOOTSTRAP_CONFIRM from CLI guard flags', () => {
    // 1. Executable source check
    const bootstrapSourcePath = path.resolve(repoRoot, 'apps/admin-cms/src/auth/stagingAdminBootstrap.ts');
    const sourceContent = fs.readFileSync(bootstrapSourcePath, 'utf8');
    expect(sourceContent).toContain('LINK_EXISTING_STAGING_ADMIN');

    // 2. Current bootstrap runbooks check
    const runbookPaths = [
      'infra/supabase/staging-admin-bootstrap.md',
      'infra/supabase/staging-auth-verification.md',
      'infra/supabase/auth-invitation-setup.md',
    ];

    runbookPaths.forEach((relPath) => {
      const fullPath = path.resolve(repoRoot, relPath);
      const docContent = fs.readFileSync(fullPath, 'utf8');

      // Must contain CAPSTONE_BOOTSTRAP_CONFIRM=LINK_EXISTING_STAGING_ADMIN
      expect(docContent).toContain('LINK_EXISTING_STAGING_ADMIN');
      // Must contain CLI flags --apply and --confirm-staging=
      expect(docContent).toContain('--apply');
      expect(docContent).toContain('--confirm-staging=');

      // No runbook must assign confirmation label to CAPSTONE_BOOTSTRAP_CONFIRM
      expect(docContent).not.toContain('CAPSTONE_BOOTSTRAP_CONFIRM="capstone-admin-cms-staging-2026"');
      expect(docContent).not.toContain('CAPSTONE_BOOTSTRAP_CONFIRM=capstone-admin-cms-staging-2026');
      expect(docContent).not.toContain('CAPSTONE_BOOTSTRAP_CONFIRM="capstone-admin-cms-staging-v2-2026"');
      expect(docContent).not.toContain('CAPSTONE_BOOTSTRAP_CONFIRM=capstone-admin-cms-staging-v2-2026');
    });

    // 3. Historical activation evidence check
    const evidencePath = path.resolve(repoRoot, 'infra/supabase/staging-auth-activation-evidence.md');
    const evidenceContent = fs.readFileSync(evidencePath, 'utf8');
    expect(evidenceContent).toContain('npm run link:admin-staging');
    expect(evidenceContent).not.toContain('npm run link:admin-staging -- --apply');

    // 4. CAPSTONE_RUNTIME_ENV documentation contract check in apps/admin-cms/README.md
    const appReadmePath = path.resolve(repoRoot, 'apps/admin-cms/README.md');
    const appReadmeContent = fs.readFileSync(appReadmePath, 'utf8');
    expect(appReadmeContent).toContain('CAPSTONE_RUNTIME_ENV');
    expect(appReadmeContent).toContain('staging');
    expect(appReadmeContent).not.toContain('(e.g. staging or local)');
  });
});
