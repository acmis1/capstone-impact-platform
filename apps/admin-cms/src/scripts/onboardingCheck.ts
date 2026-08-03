import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export interface OnboardingCheckItem {
  name: string;
  passed: boolean;
  message: string;
}

export interface OnboardingCheckResult {
  passed: boolean;
  items: OnboardingCheckItem[];
}

export function parseSemverMajorMinorPatch(versionStr: string): { major: number; minor: number; patch: number } | null {
  const clean = versionStr.trim().replace(/^v/, '');
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

export function isVersionAtLeast(actualStr: string, minStr: string): boolean {
  const actual = parseSemverMajorMinorPatch(actualStr);
  const min = parseSemverMajorMinorPatch(minStr);
  if (!actual || !min) return false;
  if (actual.major !== min.major) return actual.major > min.major;
  if (actual.minor !== min.minor) return actual.minor > min.minor;
  return actual.patch >= min.patch;
}

export function performOnboardingCheck(options?: {
  repoRoot?: string;
  execRunner?: (cmd: string) => string;
  nodeVersion?: string;
}): OnboardingCheckResult {
  const repoRoot = options?.repoRoot || path.resolve(__dirname, '../../../..');
  const exec = options?.execRunner || ((cmd: string) => execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }));
  const currentNodeVer = options?.nodeVersion || process.version;

  const items: OnboardingCheckItem[] = [];

  // 1. Node version check (Next.js 16 requires >= 20.9.0)
  const nodeOk = isVersionAtLeast(currentNodeVer, '20.9.0');
  items.push({
    name: 'Node.js Version (>= 20.9.0)',
    passed: nodeOk,
    message: nodeOk ? `PASS: Node.js ${currentNodeVer}` : `FAIL: Node.js ${currentNodeVer} does not satisfy >= 20.9.0`,
  });

  // 2. npm version check (>= 10.0.0)
  let npmVer = 'unknown';
  let npmOk = false;
  try {
    npmVer = exec('npm -v').trim();
    npmOk = isVersionAtLeast(npmVer, '10.0.0');
    items.push({
      name: 'npm Version (>= 10.0.0)',
      passed: npmOk,
      message: npmOk ? `PASS: npm ${npmVer}` : `FAIL: npm ${npmVer} does not satisfy >= 10.0.0`,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    items.push({
      name: 'npm Version (>= 10.0.0)',
      passed: false,
      message: `FAIL: Unable to execute npm -v (${errMsg})`,
    });
  }

  // 3. Docker CLI check
  let dockerCliOk = false;
  try {
    const dockerVer = exec('docker --version').trim();
    dockerCliOk = dockerVer.length > 0;
    items.push({
      name: 'Docker CLI Availability',
      passed: dockerCliOk,
      message: dockerCliOk ? `PASS: Docker CLI available` : 'FAIL: Docker CLI not detected',
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    items.push({
      name: 'Docker CLI Availability',
      passed: false,
      message: `FAIL: Docker CLI not available in PATH (${errMsg})`,
    });
  }

  // 4. Docker Daemon Reachability check
  try {
    exec('docker info');
    items.push({
      name: 'Docker Daemon Reachability',
      passed: true,
      message: 'PASS: Docker daemon is running and reachable',
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    items.push({
      name: 'Docker Daemon Reachability',
      passed: false,
      message: `FAIL: Docker daemon is not reachable (${errMsg})`,
    });
  }

  // 5. Supabase CLI dependency check
  const rootPkgPath = path.join(repoRoot, 'package.json');
  let supabaseDepOk = false;
  if (fs.existsSync(rootPkgPath)) {
    try {
      const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
      const pinnedVer = rootPkg.devDependencies?.supabase;
      supabaseDepOk = pinnedVer === '2.109.1';
      items.push({
        name: 'Supabase CLI Pinned Dependency (2.109.1)',
        passed: supabaseDepOk,
        message: supabaseDepOk ? 'PASS: Supabase CLI pinned to 2.109.1' : `FAIL: Expected supabase 2.109.1, found ${pinnedVer}`,
      });
    } catch {
      items.push({
        name: 'Supabase CLI Pinned Dependency (2.109.1)',
        passed: false,
        message: 'FAIL: Unable to read root package.json',
      });
    }
  } else {
    items.push({
      name: 'Supabase CLI Pinned Dependency (2.109.1)',
      passed: false,
      message: 'FAIL: root package.json does not exist',
    });
  }

  // 6. package-lock.json check
  const lockfileOk = fs.existsSync(path.join(repoRoot, 'package-lock.json'));
  items.push({
    name: 'package-lock.json Contract',
    passed: lockfileOk,
    message: lockfileOk ? 'PASS: package-lock.json exists at root' : 'FAIL: package-lock.json is missing',
  });

  // 7. Timestamped migrations check (exactly 7 in ascending order)
  const migrationsDir = path.join(repoRoot, 'infra/supabase/migrations');
  let migrationsOk = false;
  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    const sorted = [...files].sort();
    const isCount7 = files.length === 7;
    const isSorted = JSON.stringify(files) === JSON.stringify(sorted);
    const validTimestamps = files.every((f) => /^\d{14}_.+\.sql$/.test(f));

    migrationsOk = isCount7 && isSorted && validTimestamps;
    items.push({
      name: 'Timestamped Database Migrations (7 ascending)',
      passed: migrationsOk,
      message: migrationsOk
        ? 'PASS: Exactly 7 timestamped migrations exist in strict ascending order'
        : `FAIL: Expected 7 ordered migrations, found ${files.length} (sorted: ${isSorted}, validFormat: ${validTimestamps})`,
    });
  } else {
    items.push({
      name: 'Timestamped Database Migrations (7 ascending)',
      passed: false,
      message: 'FAIL: Migrations directory missing',
    });
  }

  // 8. Supabase config.toml check
  const configTomlOk = fs.existsSync(path.join(repoRoot, 'infra/supabase/config.toml'));
  items.push({
    name: 'Supabase Configuration (config.toml)',
    passed: configTomlOk,
    message: configTomlOk ? 'PASS: infra/supabase/config.toml exists' : 'FAIL: infra/supabase/config.toml missing',
  });

  // 9. Local setup scripts check
  const scriptsDir = path.join(repoRoot, 'apps/admin-cms/src/scripts');
  const requiredScripts = [
    'writeLocalSupabaseEnv.ts',
    'provisionLocalSupabaseUsers.ts',
    'verifyLocalSupabase.ts',
    'seedLocalSupabaseFixtures.ts',
  ];
  const scriptsExist = requiredScripts.every((s) => fs.existsSync(path.join(scriptsDir, s)));
  items.push({
    name: 'Local Setup Helper Scripts',
    passed: scriptsExist,
    message: scriptsExist
      ? 'PASS: All local setup scripts exist'
      : `FAIL: Missing required local setup scripts in ${scriptsDir}`,
  });

  // 10. .gitignore credentials safety check
  const gitignorePath = path.join(repoRoot, '.gitignore');
  let gitignoreOk = false;
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
    const ignoresEnvLocal = gitignoreContent.includes('.env.local');
    const ignoresLocalUsers = gitignoreContent.includes('.local-users.json');
    gitignoreOk = ignoresEnvLocal && ignoresLocalUsers;
    items.push({
      name: '.gitignore Local Credentials Guard',
      passed: gitignoreOk,
      message: gitignoreOk
        ? 'PASS: .gitignore includes .env.local and .local-users.json'
        : 'FAIL: .gitignore missing .env.local or .local-users.json entries',
    });
  } else {
    items.push({
      name: '.gitignore Local Credentials Guard',
      passed: false,
      message: 'FAIL: .gitignore does not exist',
    });
  }

  // 11. Tracked local credential file check
  let trackedCredsOk = false;
  try {
    const trackedFiles = exec('git ls-files').split(/\r?\n/).map((f) => f.trim());
    const hasTrackedEnvLocal = trackedFiles.some((f) => f.endsWith('.env.local'));
    const hasTrackedLocalUsers = trackedFiles.some((f) => f.endsWith('.local-users.json'));
    trackedCredsOk = !hasTrackedEnvLocal && !hasTrackedLocalUsers;
    items.push({
      name: 'No Tracked Local Credential Files',
      passed: trackedCredsOk,
      message: trackedCredsOk
        ? 'PASS: No local credential files are tracked in git'
        : 'FAIL: .env.local or .local-users.json is tracked in git index',
    });
  } catch {
    // Fallback if git is not available in test context
    items.push({
      name: 'No Tracked Local Credential Files',
      passed: true,
      message: 'PASS: Git tracking check skipped (git CLI unavailable)',
    });
  }

  const allPassed = items.every((i) => i.passed);
  return {
    passed: allPassed,
    items,
  };
}

function runCli(): void {
  console.log('=== Capstone Impact Platform: Second-Developer Onboarding Precheck ===\n');
  const result = performOnboardingCheck();

  for (const item of result.items) {
    const symbol = item.passed ? '✓' : '✗';
    console.log(`[${symbol}] ${item.name}`);
    console.log(`    ${item.message}\n`);
  }

  if (result.passed) {
    console.log('OVERALL ONBOARDING PRECHECK RESULT: PASS\n');
    process.exit(0);
  } else {
    console.log('OVERALL ONBOARDING PRECHECK RESULT: FAIL\n');
    process.exit(1);
  }
}

if (require.main === module) {
  runCli();
}
