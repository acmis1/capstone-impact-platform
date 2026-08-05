import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RehearsalResult {
  success: boolean;
  stepsCompleted: string[];
  failureStep?: string;
  errorDetail?: string;
}

export function runOnboardingWorkflowRehearsal(repoRoot = path.resolve(__dirname, '../../../../')): RehearsalResult {
  const stepsCompleted: string[] = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-rehearsal-'));
  const cloneDir = path.join(tmpDir, 'capstone-impact-platform');

  const exec = (cmd: string, cwd: string) => {
    execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8', timeout: 300_000 });
  };

  try {
    // 1. Create a clean disposable clone without shared hardlinks
    exec(`git clone --no-hardlinks "${repoRoot}" "${cloneDir}"`, tmpDir);
    stepsCompleted.push('disposable_clone_created');

    // 2. Verify clean initial checkout state
    const branch = execSync('git branch --show-current', { cwd: cloneDir, encoding: 'utf8' }).trim();
    if (!branch) throw new Error('Disposable clone has no active branch.');
    stepsCompleted.push('checkout_verified');

    // 3. Install dependencies cleanly
    exec('npm ci', cloneDir);
    stepsCompleted.push('npm_ci_completed');

    // 4. Run onboarding documentation contract check
    exec('npm run check:onboarding-docs', cloneDir);
    stepsCompleted.push('onboarding_doc_check_passed');

    // 5. Verify documented example source and test paths exist
    const docSourcePath = path.join(cloneDir, 'apps/admin-cms/src/components/admin-shell/navigation.ts');
    const docTestPath = path.join(cloneDir, 'apps/admin-cms/src/components/admin-shell/navigation.test.ts');
    if (!fs.existsSync(docSourcePath) || !fs.existsSync(docTestPath)) {
      throw new Error('Documented example navigation source or test path missing in rehearsal checkout.');
    }
    stepsCompleted.push('example_paths_verified');

    // 6. Run targeted test command from docs/first-contribution.md
    exec('npm run test:run --workspace=apps/admin-cms -- src/components/admin-shell/navigation.test.ts', cloneDir);
    stepsCompleted.push('targeted_test_passed');

    // 7. Create a temporary feature branch with an approved prefix
    const tempBranch = 'fix/rehearsal-temp-nav';
    exec(`git checkout -b ${tempBranch}`, cloneDir);
    stepsCompleted.push('feature_branch_created');

    // 8. Configure synthetic local-only Git identity for rehearsal
    exec('git config user.name "Rehearsal Bot"', cloneDir);
    exec('git config user.email "rehearsal@capstone.test"', cloneDir);

    // 9. Make a harmless, reversible modification to a documented onboarding file
    const startHerePath = path.join(cloneDir, 'START_HERE.md');
    const startHereContent = fs.readFileSync(startHerePath, 'utf8');
    fs.writeFileSync(startHerePath, `${startHereContent}\n<!-- Rehearsal Comment -->\n`);
    stepsCompleted.push('harmless_change_made');

    // 10. Stage single explicit path (git add START_HERE.md)
    exec('git add START_HERE.md', cloneDir);
    stepsCompleted.push('explicit_path_staged');

    // 11. Inspect git diff --cached and confirm unrelated files are not staged
    const cachedDiff = execSync('git diff --cached --name-only', { cwd: cloneDir, encoding: 'utf8' }).trim();
    if (cachedDiff !== 'START_HERE.md') {
      throw new Error(`Unexpected files staged in rehearsal: ${cachedDiff}`);
    }
    stepsCompleted.push('cached_diff_verified');

    // 12. Create local commit
    exec('git commit -m "docs(rehearsal): verify explicit staging workflow"', cloneDir);
    stepsCompleted.push('local_commit_created');

    // 13. Verify commit contains only intended path and migrations 0001-0008 are untouched
    const commitFiles = execSync('git show --stat --name-only --format="" HEAD', { cwd: cloneDir, encoding: 'utf8' }).trim();
    if (commitFiles !== 'START_HERE.md') {
      throw new Error(`Commit contained unexpected files: ${commitFiles}`);
    }
    const migrationDiff = execSync('git diff HEAD~1..HEAD infra/supabase/migrations/', { cwd: cloneDir, encoding: 'utf8' }).trim();
    if (migrationDiff) {
      throw new Error('Migrations 0001-0008 were unexpectedly modified during rehearsal.');
    }
    stepsCompleted.push('commit_integrity_verified');

    // 14. Verify local credentials / .env files are not tracked
    const trackedCreds = execSync('git ls-files apps/admin-cms/.env.local apps/admin-cms/.local-users.json', { cwd: cloneDir, encoding: 'utf8' }).trim();
    if (trackedCreds) {
      throw new Error(`Local credential files tracked in rehearsal: ${trackedCreds}`);
    }
    stepsCompleted.push('local_credentials_untracked_verified');

    return {
      success: true,
      stepsCompleted,
    };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    const lastStep = stepsCompleted[stepsCompleted.length - 1] || 'clone_init';
    return {
      success: false,
      stepsCompleted,
      failureStep: lastStep,
      errorDetail: detail,
    };
  } finally {
    // 15. Clean up temporary disposable clone directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('rehearseOnboardingWorkflow.ts')) {
  console.log('Starting automated developer onboarding contributor workflow rehearsal...');
  const res = runOnboardingWorkflowRehearsal();
  if (res.success) {
    console.log('✅ Onboarding contributor workflow rehearsal PASSED cleanly.');
    console.log(`Completed steps: ${res.stepsCompleted.join(', ')}`);
  } else {
    console.error(`❌ Onboarding contributor workflow rehearsal FAILED at step [${res.failureStep}].`);
    console.error(`Detail: ${res.errorDetail}`);
    process.exitCode = 1;
  }
}
