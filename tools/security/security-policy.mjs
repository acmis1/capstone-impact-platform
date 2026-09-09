import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, '../..');
const WORKFLOW_EXTENSIONS = new Set(['.yml', '.yaml']);
const V1_PROTOCOL_FREEZE_SHA = '0485a8b7fda3f3e9f9873849104cd90917b4f395';
const V1_PROTOCOL_FREEZE_TAG = 'refs/tags/evidence/ocr-productionization-v1-freeze';

function relative(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).replaceAll('\\', '/');
}

function workflowFiles(repoRoot) {
  const directory = path.join(repoRoot, '.github', 'workflows');
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && WORKFLOW_EXTENSIONS.has(path.extname(entry.name)))
    .map((entry) => path.join(directory, entry.name));
}

export function checkWorkflowSource(filePath, source) {
  const failures = [];
  const lines = source.split(/\r?\n/);
  const isPullRequestWorkflow = /^\s{2}pull_request:\s*$/m.test(source);

  if (/^\s{2}pull_request_target:\s*$/m.test(source)) {
    failures.push('pull_request_target is prohibited');
  }
  if (!/^permissions:\s*\r?\n/m.test(source)) {
    failures.push('top-level permissions are not declared');
  }
  if (isPullRequestWorkflow) {
    if (/^\s+[A-Za-z][A-Za-z-]*:\s*write\s*$/m.test(source)) {
      failures.push('pull_request workflow grants a write permission');
    }
    if (source.includes('${{ secrets.')) {
      failures.push('pull_request workflow references repository secrets');
    }
  }

  lines.forEach((line, index) => {
    const hasUses = /^\s*(?:-\s+)?uses:\s*/.test(line);
    if (/^\s*(?:-\s+)?uses:\s*\.\//.test(line)) return;
    const use = /^\s*(?:-\s+)?uses:\s*([^\s@]+)@([^\s#]+)(?:\s+#\s*(v[^\s]+))?\s*$/.exec(line);
    if (hasUses && !use) {
      failures.push(`line ${index + 1}: action reference has unsupported or unpinned syntax`);
      return;
    }
    if (!use) return;
    if (!/^[0-9a-f]{40}$/.test(use[2])) {
      failures.push(`line ${index + 1}: action is not pinned to a 40-character commit SHA`);
    }
    if (!use[3]) {
      failures.push(`line ${index + 1}: pinned action lacks a version comment`);
    }
    if (isPullRequestWorkflow && use[1] === 'actions/checkout') {
      const stepTail = lines.slice(index + 1, index + 9).join('\n');
      if (!/^\s+persist-credentials:\s*false\s*$/m.test(stepTail)) {
        failures.push(`line ${index + 1}: pull_request checkout persists credentials`);
      }
    }
  });

  if (
    path.basename(filePath) === 'assistive-benchmark-ci.yml'
    && !/^\s+fetch-depth:\s*0\s*$/m.test(source)
  ) {
    failures.push('assistive benchmark evidence requires full Git history');
  }
  if (
    path.basename(filePath) === 'assistive-benchmark-ci.yml'
    && (
      !source.includes(`freeze_tag='${V1_PROTOCOL_FREEZE_TAG}'`)
      || !source.includes(`freeze_sha='${V1_PROTOCOL_FREEZE_SHA}'`)
      || !source.includes('git fetch --no-tags origin "${freeze_tag}:${freeze_tag}"')
      || !source.includes('test "$(git cat-file -t "$freeze_tag")" = \'tag\'')
      || !source.includes('test "$(git rev-parse "${freeze_tag}^{}")" = "$freeze_sha"')
    )
  ) {
    failures.push('assistive benchmark evidence must verify the annotated v1 freeze tag and exact commit');
  }

  if (path.basename(filePath) === 'codeql.yml') {
    if (isPullRequestWorkflow) failures.push('CodeQL write-capable analysis must not run on pull_request');
    if (!/^\s+security-events:\s*write\s*$/m.test(source)) {
      failures.push('CodeQL analysis lacks security-events: write');
    }
    if (!/^\s+build-mode:\s*none\s*$/m.test(source)) {
      failures.push('CodeQL must use build-mode none and not execute repository build scripts');
    }
  }

  return failures;
}

function comparableDependencies(value) {
  return value ?? {};
}

function sameDependencies(left, right) {
  return JSON.stringify(comparableDependencies(left)) === JSON.stringify(comparableDependencies(right));
}

export function checkLockfile(repoRoot, lockRelativePath, packageRelativePath, workspacePath = '') {
  const failures = [];
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, lockRelativePath), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, packageRelativePath), 'utf8'));
  const root = lock.packages?.[workspacePath];
  if (lock.lockfileVersion !== 3) failures.push(`${lockRelativePath}: expected lockfileVersion 3`);
  if (!root) failures.push(`${lockRelativePath}: missing package entry ${workspacePath || '<root>'}`);
  if (root) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (!sameDependencies(root[field], manifest[field])) {
        failures.push(`${lockRelativePath}: ${workspacePath || '<root>'} ${field} drifted from its manifest`);
      }
    }
  }
  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    if (!packagePath.startsWith('node_modules/') || !entry.resolved || entry.link) continue;
    if (!entry.resolved.startsWith('https://registry.npmjs.org/')) {
      failures.push(`${lockRelativePath}: ${packagePath} resolves outside the npm registry`);
    }
    if (!entry.integrity) failures.push(`${lockRelativePath}: ${packagePath} lacks integrity metadata`);
  }
  return failures;
}

export function checkSecurityPolicy(repoRoot = defaultRepoRoot) {
  const failures = [];
  for (const filePath of workflowFiles(repoRoot)) {
    const file = relative(repoRoot, filePath);
    for (const failure of checkWorkflowSource(filePath, fs.readFileSync(filePath, 'utf8'))) {
      failures.push(`${file}: ${failure}`);
    }
  }
  const dependabot = fs.readFileSync(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
  for (const ecosystem of ['npm', 'pip', 'github-actions']) {
    if (!dependabot.includes(`package-ecosystem: ${ecosystem}`)) {
      failures.push(`.github/dependabot.yml: missing ${ecosystem} updates`);
    }
  }
  const securityWorkflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'security.yml'),
    'utf8',
  );
  const productionAuditJob = securityWorkflow.split(/^  production-advisory-audit:\s*$/m)[1] ?? '';
  if (!productionAuditJob) {
    failures.push('.github/workflows/security.yml: root production advisory audit job is missing');
  } else if (!/^\s+run:\s*npm audit --package-lock-only --omit=dev --audit-level=high\s*$/m.test(productionAuditJob)) {
    failures.push('.github/workflows/security.yml: root production advisory audit command changed');
  }
  if (/^  dependency-review:\s*$/m.test(securityWorkflow) || securityWorkflow.includes('actions/dependency-review-action@')) {
    failures.push('.github/workflows/security.yml: unsupported dependency review action must not be required');
  }
  failures.push(...checkLockfile(repoRoot, 'package-lock.json', 'package.json'));
  failures.push(...checkLockfile(
    repoRoot,
    'package-lock.json',
    'apps/admin-cms/package.json',
    'apps/admin-cms',
  ));
  failures.push(...checkLockfile(repoRoot, 'Prototype/package-lock.json', 'Prototype/package.json'));
  failures.push(...checkLockfile(
    repoRoot,
    'tools/assistive-validation-benchmark/package-lock.json',
    'tools/assistive-validation-benchmark/package.json',
  ));
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkSecurityPolicy();
  if (failures.length) {
    console.error('Security CI policy check failed:');
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exitCode = 1;
  } else {
    console.log('Security CI policy check passed: actions pinned, PR tokens read-only, lockfiles intact.');
  }
}
