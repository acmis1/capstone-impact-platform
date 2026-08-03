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

export function isVersionInNode24Range(versionStr: string): boolean {
  const parsed = parseSemverMajorMinorPatch(versionStr);
  if (!parsed) return false;
  if (parsed.major !== 24) return false;
  if (parsed.minor < 14) return false;
  if (parsed.minor === 14 && parsed.patch < 1) return false;
  return true;
}

export function isVersionInNpm11Range(versionStr: string): boolean {
  const parsed = parseSemverMajorMinorPatch(versionStr);
  if (!parsed) return false;
  if (parsed.major !== 11) return false;
  if (parsed.minor < 11) return false;
  return true;
}

export function validateMigrationsList(filenames: string[]): { passed: boolean; message: string } {
  const sqlFiles = filenames.filter((f) => f.endsWith('.sql'));
  if (sqlFiles.length !== 7) {
    return { passed: false, message: `FAIL: Expected exactly 7 migration files, found ${sqlFiles.length}` };
  }

  const timestampRegex = /^(\d{14})_.+\.sql$/;
  const timestamps: string[] = [];

  for (const file of sqlFiles) {
    const match = file.match(timestampRegex);
    if (!match) {
      return { passed: false, message: `FAIL: Migration filename "${file}" does not match 14-digit timestamp format` };
    }
    timestamps.push(match[1]);
  }

  // Check timestamp uniqueness
  const uniqueTimestamps = new Set(timestamps);
  if (uniqueTimestamps.size !== timestamps.length) {
    return { passed: false, message: `FAIL: Duplicate migration timestamps detected` };
  }

  // Sort internally and verify strict ascending order
  const sortedFiles = [...sqlFiles].sort((a, b) => a.localeCompare(b));
  const sortedTimestamps = sortedFiles.map((f) => f.match(timestampRegex)![1]);

  for (let i = 1; i < sortedTimestamps.length; i++) {
    if (sortedTimestamps[i] <= sortedTimestamps[i - 1]) {
      return { passed: false, message: `FAIL: Migrations are not in strict ascending timestamp order` };
    }
  }

  const expectedFinal = '20260803174000_harden_function_execute_defaults.sql';
  const actualFinal = sortedFiles[sortedFiles.length - 1];
  if (actualFinal !== expectedFinal) {
    return { passed: false, message: `FAIL: Expected final migration "${expectedFinal}", found "${actualFinal}"` };
  }

  return { passed: true, message: 'PASS: Exactly 7 timestamped migrations exist in strict ascending order ending with 0007' };
}

export function sanitizePublicSafeMessage(msg: string): string {
  // Strip absolute paths and user profile directory paths to prevent leaking personal paths
  return msg
    .replace(/[A-Za-z]:\\[^\s:]+/g, '<relative-path>')
    .replace(/\/Users\/[^\s:]+/g, '<relative-path>')
    .replace(/\/home\/[^\s:]+/g, '<relative-path>');
}

export function performOnboardingCheck(options?: {
  repoRoot?: string;
  execRunner?: (cmd: string) => string;
  nodeVersion?: string;
  fsOverride?: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc?: string) => string;
    readdirSync?: (p: string) => string[];
  };
}): OnboardingCheckResult {
  const repoRoot = options?.repoRoot || path.resolve(__dirname, '../../../..');
  const exec = options?.execRunner || ((cmd: string) => execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }));
  const currentNodeVer = options?.nodeVersion || process.version;
  const existsSync = options?.fsOverride?.existsSync || fs.existsSync;
  const readFileSync = options?.fsOverride?.readFileSync || fs.readFileSync;
  const readdirSync = options?.fsOverride?.readdirSync || fs.readdirSync;

  const items: OnboardingCheckItem[] = [];

  // 1. Node version check (Supported range: >=24.14.1 <25, recommended .nvmrc 24.14.1)
  const nodeOk = isVersionInNode24Range(currentNodeVer);
  items.push({
    name: 'Node.js Toolchain (>=24.14.1 <25)',
    passed: nodeOk,
    message: nodeOk
      ? `PASS: Node.js ${currentNodeVer} (matches .nvmrc 24.14.1)`
      : `FAIL: Node.js ${currentNodeVer} does not satisfy supported Node 24 range (>=24.14.1 <25)`,
  });

  // 2. npm version check (Supported range: >=11.11.0 <12, recommended packageManager npm@11.11.0)
  let npmVer = 'unknown';
  let npmOk = false;
  try {
    npmVer = exec('npm -v').trim();
    npmOk = isVersionInNpm11Range(npmVer);
    items.push({
      name: 'npm Package Manager (>=11.11.0 <12)',
      passed: npmOk,
      message: npmOk
        ? `PASS: npm ${npmVer} (matches packageManager npm@11.11.0)`
        : `FAIL: npm ${npmVer} does not satisfy supported npm 11 range (>=11.11.0 <12)`,
    });
  } catch {
    items.push({
      name: 'npm Package Manager (>=11.11.0 <12)',
      passed: false,
      message: 'FAIL: Unable to execute npm CLI',
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
      message: dockerCliOk ? 'PASS: Docker CLI available' : 'FAIL: Docker CLI not detected',
    });
  } catch {
    items.push({
      name: 'Docker CLI Availability',
      passed: false,
      message: 'FAIL: Docker CLI not available in PATH',
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
  } catch {
    items.push({
      name: 'Docker Daemon Reachability',
      passed: false,
      message: 'FAIL: Docker daemon is not reachable',
    });
  }

  // 5. Git CLI & Repository Index check
  let gitOk = false;
  let trackedFiles: string[] = [];
  try {
    const gitVer = exec('git --version').trim();
    if (gitVer.length > 0) {
      const gitLsOutput = exec('git ls-files');
      trackedFiles = gitLsOutput.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
      gitOk = trackedFiles.length > 0;
    }
  } catch {
    gitOk = false;
  }

  items.push({
    name: 'Git CLI & Repository Index Availability',
    passed: gitOk,
    message: gitOk ? 'PASS: Git CLI available and repository index queried' : 'FAIL: Git CLI is unavailable or git ls-files command failed',
  });

  // 6. Supabase CLI Pinned Dependency & Local Installed Binary check
  const rootPkgPath = path.join(repoRoot, 'package.json');
  const installedSupaPkgPath = path.join(repoRoot, 'node_modules/supabase/package.json');

  let supabaseDepOk = false;
  let supabaseInstalledOk = false;
  let supabaseBinaryOk = false;

  if (existsSync(rootPkgPath)) {
    try {
      const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
      supabaseDepOk = rootPkg.devDependencies?.supabase === '2.109.1';
    } catch {
      supabaseDepOk = false;
    }
  }

  if (existsSync(installedSupaPkgPath)) {
    try {
      const supaPkg = JSON.parse(readFileSync(installedSupaPkgPath, 'utf8'));
      supabaseInstalledOk = supaPkg.version === '2.109.1';
    } catch {
      supabaseInstalledOk = false;
    }
  }

  // Check for local CLI binary target inside node_modules
  const localBinaryPathWin = path.join(repoRoot, 'node_modules/supabase/bin/supabase.exe');
  const localBinaryPathNix = path.join(repoRoot, 'node_modules/supabase/bin/supabase');
  const localBinCmdPathWin = path.join(repoRoot, 'node_modules/.bin/supabase.cmd');
  const localBinCmdPathNix = path.join(repoRoot, 'node_modules/.bin/supabase');

  supabaseBinaryOk =
    existsSync(localBinaryPathWin) ||
    existsSync(localBinaryPathNix) ||
    existsSync(localBinCmdPathWin) ||
    existsSync(localBinCmdPathNix);

  const supabaseOverallOk = supabaseDepOk && supabaseInstalledOk && supabaseBinaryOk;
  let supaMsg = 'PASS: Supabase CLI 2.109.1 declared, installed locally, and binary binary exists';
  if (!supabaseDepOk) supaMsg = 'FAIL: root package.json devDependencies does not declare supabase 2.109.1';
  else if (!supabaseInstalledOk) supaMsg = 'FAIL: Installed node_modules/supabase/package.json is missing or version is not 2.109.1';
  else if (!supabaseBinaryOk) supaMsg = 'FAIL: Local Supabase binary executable is missing from node_modules';

  items.push({
    name: 'Installed Supabase CLI (2.109.1)',
    passed: supabaseOverallOk,
    message: supaMsg,
  });

  // 7. package-lock.json check
  const lockfileOk = existsSync(path.join(repoRoot, 'package-lock.json'));
  items.push({
    name: 'package-lock.json Contract',
    passed: lockfileOk,
    message: lockfileOk ? 'PASS: package-lock.json exists at root' : 'FAIL: package-lock.json is missing',
  });

  // 8. Timestamped migrations check
  const migrationsDir = path.join(repoRoot, 'infra/supabase/migrations');
  if (existsSync(migrationsDir)) {
    const rawFiles = readdirSync(migrationsDir);
    const migResult = validateMigrationsList(rawFiles);
    items.push({
      name: 'Timestamped Database Migrations (7 ascending)',
      passed: migResult.passed,
      message: migResult.message,
    });
  } else {
    items.push({
      name: 'Timestamped Database Migrations (7 ascending)',
      passed: false,
      message: 'FAIL: Migrations directory missing',
    });
  }

  // 9. Supabase config.toml check
  const configTomlOk = existsSync(path.join(repoRoot, 'infra/supabase/config.toml'));
  items.push({
    name: 'Supabase Configuration (config.toml)',
    passed: configTomlOk,
    message: configTomlOk ? 'PASS: infra/supabase/config.toml exists' : 'FAIL: infra/supabase/config.toml missing',
  });

  // 10. Local setup scripts check
  const scriptsDir = path.join(repoRoot, 'apps/admin-cms/src/scripts');
  const requiredScripts = [
    'writeLocalSupabaseEnv.ts',
    'provisionLocalSupabaseUsers.ts',
    'verifyLocalSupabase.ts',
    'seedLocalSupabaseFixtures.ts',
  ];
  const scriptsExist = requiredScripts.every((s) => existsSync(path.join(scriptsDir, s)));
  items.push({
    name: 'Local Setup Helper Scripts',
    passed: scriptsExist,
    message: scriptsExist
      ? 'PASS: All local setup scripts exist'
      : 'FAIL: Missing required local setup scripts in scripts directory',
  });

  // 11. .gitignore local credentials guard check
  const gitignorePath = path.join(repoRoot, '.gitignore');
  let gitignoreOk = false;
  if (existsSync(gitignorePath)) {
    const gitignoreContent = readFileSync(gitignorePath, 'utf8');
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

  // 12. No tracked local credential files check (fails if git unavailable or tracked)
  if (!gitOk) {
    items.push({
      name: 'No Tracked Local Credential Files',
      passed: false,
      message: 'FAIL: Cannot verify tracked credentials because Git CLI index is unavailable',
    });
  } else {
    const hasTrackedEnvLocal = trackedFiles.some((f) => f.endsWith('.env.local'));
    const hasTrackedLocalUsers = trackedFiles.some((f) => f.endsWith('.local-users.json'));
    const trackedCredsOk = !hasTrackedEnvLocal && !hasTrackedLocalUsers;
    items.push({
      name: 'No Tracked Local Credential Files',
      passed: trackedCredsOk,
      message: trackedCredsOk
        ? 'PASS: No local credential files are tracked in git'
        : 'FAIL: .env.local or .local-users.json is tracked in git index',
    });
  }

  // Sanitize all messages for public-safe output
  const sanitizedItems = items.map((i) => ({
    ...i,
    message: sanitizePublicSafeMessage(i.message),
  }));

  const allPassed = sanitizedItems.every((i) => i.passed);
  return {
    passed: allPassed,
    items: sanitizedItems,
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
