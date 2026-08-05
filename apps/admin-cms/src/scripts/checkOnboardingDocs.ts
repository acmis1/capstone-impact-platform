import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checkMarkdownLinks, checkTerminology, checkYaml } from './repositoryChecks';

const require = createRequire(import.meta.url);

export function checkOnboardingDocs(repoRoot = path.resolve(__dirname, '../../../../')): string[] {
  const failures: string[] = [];

  // 1. Required onboarding files exist
  const requiredFiles = [
    'README.md',
    'START_HERE.md',
    'CONTRIBUTING.md',
    'AGENTS.md',
    'apps/admin-cms/README.md',
    'docs/README.md',
    'docs/first-contribution.md',
    'docs/onboarding-acceptance-checklist.md',
    'docs/developer-troubleshooting.md',
    'docs/project-architecture-and-constraints.md',
    'docs/implementation-backlog.md',
    'infra/supabase/README.md',
    'infra/supabase/local-development.md',
  ];

  for (const relativePath of requiredFiles) {
    const fullPath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(fullPath)) {
      failures.push(`Missing required onboarding document: ${relativePath}`);
    }
  }

  // 2. Canonical setup command appears in expected entry-point documents
  const canonicalCommand = 'npm run setup:local';
  const entryPointDocs = [
    'README.md',
    'START_HERE.md',
    'CONTRIBUTING.md',
    'apps/admin-cms/README.md',
    'infra/supabase/local-development.md',
    'docs/first-contribution.md',
    'docs/onboarding-acceptance-checklist.md',
  ];

  for (const relativePath of entryPointDocs) {
    const fullPath = path.join(repoRoot, relativePath);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (!content.includes(canonicalCommand)) {
        failures.push(`${relativePath}: Missing canonical setup command '${canonicalCommand}'`);
      }
    }
  }

  // 3. CONTRIBUTING.md does not present destructive reset as default fresh-clone workflow
  const contributingPath = path.join(repoRoot, 'CONTRIBUTING.md');
  if (fs.existsSync(contributingPath)) {
    const content = fs.readFileSync(contributingPath, 'utf8');
    const freshCloneSection = content.split('## C.')[0] || '';
    const bashCodeBlocks = freshCloneSection.match(/```bash[\s\S]*?```/g) || [];
    if (bashCodeBlocks.some((block) => block.includes('npm run supabase:reset'))) {
      failures.push(`CONTRIBUTING.md: Fresh-clone bash code block includes destructive 'npm run supabase:reset' as default step`);
    }
  }

  // 4. Documented example source and test paths exist
  const examplePaths = [
    'apps/admin-cms/src/components/admin-shell/navigation.ts',
    'apps/admin-cms/src/components/admin-shell/navigation.test.ts',
  ];
  for (const relativePath of examplePaths) {
    if (!fs.existsSync(path.join(repoRoot, relativePath))) {
      failures.push(`Documented example path does not exist: ${relativePath}`);
    }
  }

  // 5. Documented npm scripts exist in relevant package.json
  const rootPkgPath = path.join(repoRoot, 'package.json');
  const appPkgPath = path.join(repoRoot, 'apps/admin-cms/package.json');
  const rootPkg = fs.existsSync(rootPkgPath) ? JSON.parse(fs.readFileSync(rootPkgPath, 'utf8')) as { scripts?: Record<string, string> } : {};
  const appPkg = fs.existsSync(appPkgPath) ? JSON.parse(fs.readFileSync(appPkgPath, 'utf8')) as { scripts?: Record<string, string> } : {};

  const requiredRootScripts = ['setup:local', 'dev:admin', 'supabase:stop', 'verify:all', 'onboarding:check', 'check:onboarding-docs'];
  for (const script of requiredRootScripts) {
    if (!rootPkg.scripts?.[script]) {
      failures.push(`Root package.json missing required script: ${script}`);
    }
  }

  const requiredAppScripts = ['setup:local', 'dev', 'check:onboarding', 'test:run'];
  for (const script of requiredAppScripts) {
    if (!appPkg.scripts?.[script]) {
      failures.push(`apps/admin-cms/package.json missing required script: ${script}`);
    }
  }

  // 6. Troubleshooting path exists
  const troubleshootingPath = path.join(repoRoot, 'docs/developer-troubleshooting.md');
  if (!fs.existsSync(troubleshootingPath)) {
    failures.push(`Developer troubleshooting guide missing: docs/developer-troubleshooting.md`);
  }

  // 7. Prohibited stale path names are absent
  const stalePaths = ['participant-troubleshooting.md'];
  for (const docPath of entryPointDocs) {
    const fullPath = path.join(repoRoot, docPath);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const stale of stalePaths) {
        if (content.includes(stale)) {
          failures.push(`${docPath}: Contains prohibited stale path name '${stale}'`);
        }
      }
    }
  }

  // 8. Duplicate numbered top-level onboarding sections are rejected in START_HERE.md
  const startHerePath = path.join(repoRoot, 'START_HERE.md');
  if (fs.existsSync(startHerePath)) {
    const content = fs.readFileSync(startHerePath, 'utf8');
    const sectionMatches = content.match(/^##\s+(\d+)\./gm) || [];
    const sectionNumbers = sectionMatches.map((m) => parseInt(m.replace(/\D/g, ''), 10));
    const duplicates = sectionNumbers.filter((item, index) => sectionNumbers.indexOf(item) !== index);
    if (duplicates.length > 0) {
      failures.push(`START_HERE.md: Duplicate section numbers detected: ${Array.from(new Set(duplicates)).join(', ')}`);
    }
  }

  // 9. First-contribution targeted test command references a tracked test file
  const firstContribPath = path.join(repoRoot, 'docs/first-contribution.md');
  if (fs.existsSync(firstContribPath)) {
    const content = fs.readFileSync(firstContribPath, 'utf8');
    const commandMatch = content.match(/npm run test:run --workspace=apps\/admin-cms -- ([^\s`\n]+)/);
    if (!commandMatch) {
      failures.push(`docs/first-contribution.md: Missing targeted test command pattern`);
    } else {
      const testFileRelative = commandMatch[1];
      const targetTestPath = path.join(repoRoot, 'apps/admin-cms', testFileRelative);
      if (!fs.existsSync(targetTestPath)) {
        failures.push(`docs/first-contribution.md: Targeted test file does not exist: ${testFileRelative}`);
      }
    }
  }

  // 10. START_HERE.md does not claim Ubuntu CI verification is pending
  const startHereDocPath = path.join(repoRoot, 'START_HERE.md');
  if (fs.existsSync(startHereDocPath)) {
    const content = fs.readFileSync(startHereDocPath, 'utf8');
    if (content.includes('Ubuntu CI verification remains pending')) {
      failures.push(`START_HERE.md: Contains stale claim 'Ubuntu CI verification remains pending'`);
    }
    if (!content.includes('Ubuntu 24.04 GitHub Actions integration acceptance has passed')) {
      failures.push(`START_HERE.md: Missing required assertion 'Ubuntu 24.04 GitHub Actions integration acceptance has passed'`);
    }
  }

  // Also include general terminology, YAML, and link checks
  failures.push(...checkTerminology(repoRoot));
  failures.push(...checkYaml(repoRoot));
  failures.push(...checkMarkdownLinks(repoRoot));

  return failures;
}

if (process.argv[1] && process.argv[1].endsWith('checkOnboardingDocs.ts')) {
  const failures = checkOnboardingDocs();
  if (failures.length) {
    console.error('Onboarding documentation contract check failed:');
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exitCode = 1;
  } else {
    console.log('Onboarding documentation contract check passed.');
  }
}
