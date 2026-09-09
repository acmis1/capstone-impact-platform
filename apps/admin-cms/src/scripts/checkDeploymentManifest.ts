import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load(input: string): unknown };

export const DEPLOYMENT_MANIFEST_PATH = 'infra/deployment/admin-cms-staging.manifest.yaml';
const EXPECTED_BUILD_COMMAND = 'npm ci && npm run build:admin';
const EXPECTED_START_COMMAND = 'npm run start --workspace=apps/admin-cms';
const EXPECTED_HEALTH_PATH = '/api/readiness';
const EXPECTED_NODE_VERSION = '24.14.1';
const EXPECTED_NPM_VERSION = '11.11.0';
const EXPECTED_ENV_VALUES = new Map<string, string | boolean>([
  ['CAPSTONE_RUNTIME_ENV', 'staging'],
  ['SUPABASE_DRAFT_BUCKET', 'project-drafts-private'],
  ['SUPABASE_PUBLIC_ASSETS_BUCKET', 'project-public-assets'],
  ['SUPABASE_PUBLIC_FEEDS_BUCKET', 'public-feeds'],
  ['SUPABASE_PUBLIC_FEED_FILE', 'capstones-latest.json'],
  ['GEMINI_ASSISTIVE_EXTRACTION_ENABLED', false],
  ['PARTICIPANT_PREVIEW_EMAIL_ENABLED', false],
  ['PARTICIPANT_PREVIEW_REMINDERS_ENABLED', false],
  ['STAFF_PROVISIONING_ENABLED', false],
  ['CAPSTONE_STAGING_PUBLICATION_ENABLED', false],
  ['CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED', false],
]);
const REQUIRED_ENV_NAMES = new Set([
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'CAPSTONE_AUTH_FLOW_SECRET',
  'CAPSTONE_RUNTIME_ENV',
  'CAPSTONE_EXPECTED_SUPABASE_HOST',
]);
const OWNER_SUPPLIED_ENV_NAMES = new Set([
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'CAPSTONE_AUTH_FLOW_SECRET',
  'CAPSTONE_EXPECTED_SUPABASE_HOST',
  'CAPSTONE_STAGING_MUTATION_CONFIRMATION',
  'GEMINI_API_KEY',
]);
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(repoRoot: string, relativePath: string): UnknownRecord {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${relativePath} is not a JSON object`);
  return parsed;
}

export function loadDeploymentManifest(repoRoot: string): UnknownRecord {
  const parsed = yaml.load(fs.readFileSync(path.join(repoRoot, DEPLOYMENT_MANIFEST_PATH), 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${DEPLOYMENT_MANIFEST_PATH} is not a YAML object`);
  return parsed;
}

function expectEqual(
  failures: string[],
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}`);
}

function expectFalse(failures: string[], value: unknown, label: string): void {
  if (value !== false) failures.push(`${label}: must be false`);
}

function checkEnvironment(failures: string[], manifest: UnknownRecord): void {
  const entries = manifest.environment;
  if (!Array.isArray(entries)) {
    failures.push('environment: expected a list');
    return;
  }

  const names = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      failures.push('environment: every entry needs a name');
      continue;
    }
    const name = entry.name;
    if (names.has(name)) failures.push(`environment.${name}: duplicate entry`);
    names.add(name);

    if (!Object.prototype.hasOwnProperty.call(entry, 'value')) {
      failures.push(`environment.${name}.value: explicit null/value required`);
      continue;
    }
    if ((entry.secret === true || OWNER_SUPPLIED_ENV_NAMES.has(name)
      || entry.source === 'owner-config' || entry.source === 'owner-secret-store')
      && entry.value !== null) {
      failures.push(`environment.${name}.value: owner-supplied or secret values must be null`);
    }
    if (EXPECTED_ENV_VALUES.has(name)) {
      expectEqual(failures, entry.value, EXPECTED_ENV_VALUES.get(name), `environment.${name}.value`);
    }
    if (REQUIRED_ENV_NAMES.has(name) && entry.required !== true) {
      failures.push(`environment.${name}.required: must be true`);
    }
  }

  for (const requiredName of REQUIRED_ENV_NAMES) {
    if (!names.has(requiredName)) failures.push(`environment: missing ${requiredName}`);
  }
}
export function verifyDeploymentManifest(
  repoRoot: string,
  manifest = loadDeploymentManifest(repoRoot),
): string[] {
  const failures: string[] = [];
  const identity = isRecord(manifest.identity) ? manifest.identity : {};
  const service = isRecord(manifest.service) ? manifest.service : {};
  const runtime = isRecord(service.runtime) ? service.runtime : {};
  const commands = isRecord(service.commands) ? service.commands : {};
  const health = isRecord(service.health) ? service.health : {};
  const reconciliation = isRecord(manifest.reconciliation) ? manifest.reconciliation : {};

  expectEqual(failures, manifest.manifestVersion, 1, 'manifestVersion');
  expectEqual(failures, manifest.kind, 'WebDeploymentReconciliationManifest', 'kind');
  expectEqual(failures, manifest.applyMode, 'manual-reconciliation-only', 'applyMode');
  expectEqual(failures, identity.application, 'admin-cms', 'identity.application');
  expectEqual(failures, identity.environment, 'staging', 'identity.environment');
  expectEqual(failures, identity.dataClass, 'synthetic-only', 'identity.dataClass');
  expectFalse(failures, identity.productionCutover, 'identity.productionCutover');
  expectFalse(failures, identity.liveDudaPublication, 'identity.liveDudaPublication');

  expectEqual(failures, service.provider, 'render', 'service.provider');
  expectEqual(failures, service.name, 'capstone-admin-cms-staging-v2', 'service.name');
  expectEqual(failures, service.sourceBranch, 'main', 'service.sourceBranch');
  expectEqual(failures, service.region, 'ap-southeast-1', 'service.region');
  expectEqual(failures, service.plan, 'free', 'service.plan');
  expectFalse(failures, service.autoDeploy, 'service.autoDeploy');
  expectEqual(failures, service.rootDirectory, '.', 'service.rootDirectory');
  expectEqual(failures, runtime.name, 'node', 'service.runtime.name');
  expectEqual(failures, runtime.version, EXPECTED_NODE_VERSION, 'service.runtime.version');
  expectEqual(failures, runtime.npmVersion, EXPECTED_NPM_VERSION, 'service.runtime.npmVersion');
  expectEqual(failures, commands.installAndBuild, EXPECTED_BUILD_COMMAND, 'service.commands.installAndBuild');
  expectEqual(failures, commands.start, EXPECTED_START_COMMAND, 'service.commands.start');
  expectEqual(failures, health.path, EXPECTED_HEALTH_PATH, 'service.health.path');
  expectEqual(failures, health.expectedStatus, 200, 'service.health.expectedStatus');
  expectEqual(failures, reconciliation.providerImportMustNotPublish, true, 'reconciliation.providerImportMustNotPublish');
  expectEqual(failures, reconciliation.automaticDeploymentMustRemainOff, true, 'reconciliation.automaticDeploymentMustRemainOff');
  expectEqual(failures, reconciliation.productionAndLiveDudaMustRemainSeparate, true, 'reconciliation.productionAndLiveDudaMustRemainSeparate');
  expectEqual(failures, reconciliation.ownerMustRecheckProviderTerms, true, 'reconciliation.ownerMustRecheckProviderTerms');
  const rootPackage = readJson(repoRoot, 'package.json');
  const appPackage = readJson(repoRoot, 'apps/admin-cms/package.json');
  expectEqual(failures, rootPackage.packageManager, `npm@${EXPECTED_NPM_VERSION}`, 'packageManager');
  const rootEngines = isRecord(rootPackage.engines) ? rootPackage.engines : {};
  expectEqual(failures, rootEngines.node, '>=24.14.1 <25', 'root engines.node');
  expectEqual(failures, rootEngines.npm, '>=11.11.0 <12', 'root engines.npm');
  const rootScripts = isRecord(rootPackage.scripts) ? rootPackage.scripts : {};
  const appScripts = isRecord(appPackage.scripts) ? appPackage.scripts : {};
  expectEqual(failures, rootScripts['build:admin'], 'npm run build --workspace=apps/admin-cms', 'root scripts.build:admin');
  expectEqual(failures, appScripts.build, 'next build', 'admin scripts.build');
  expectEqual(failures, appScripts.start, 'next start', 'admin scripts.start');
  expectEqual(failures, fs.readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8').trim(), EXPECTED_NODE_VERSION, '.nvmrc');

  const readinessRoute = path.join(repoRoot, 'apps/admin-cms/src/app/api/readiness/route.ts');
  if (!fs.existsSync(readinessRoute)) failures.push('service.health.path: readiness route is missing');
  else {
    const source = fs.readFileSync(readinessRoute, 'utf8');
    if (!source.includes('export async function GET')) failures.push('service.health.path: readiness GET handler is missing');
    if (!source.includes('export async function HEAD')) failures.push('service.health.path: readiness HEAD handler is missing');
  }

  checkEnvironment(failures, manifest);
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const repoRoot = path.resolve(__dirname, '../../../../');
  const failures = verifyDeploymentManifest(repoRoot);
  if (failures.length > 0) {
    console.error('Deployment manifest verification failed:');
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exitCode = 1;
  } else {
    console.log('DEPLOYMENT_MANIFEST_CLASSIFICATION = PASS_MANUAL_STAGING_RECONCILIATION');
  }
}
