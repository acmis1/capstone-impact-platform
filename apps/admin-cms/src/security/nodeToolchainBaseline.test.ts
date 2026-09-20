import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createRequire } from 'node:module';

import { NODE_24_BASELINE_VERSION, NODE_24_RANGE_LABEL } from '../scripts/onboardingCheck';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load(input: string): unknown };

const NPM_PIN = '11.11.0';
const NPM_PIN_COMMAND = `npm install -g npm@${NPM_PIN}`;

/**
 * Every active toolchain contract must carry the same Node 24 maintenance baseline. Dated evidence
 * documents keep their historical versions and are deliberately not listed here.
 */
const repoRoot = path.resolve(__dirname, '../../../../');
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const readJson = (relative: string) => JSON.parse(read(relative)) as Record<string, unknown>;

const WORKFLOWS = [
  '.github/workflows/ci.yml',
  '.github/workflows/security.yml',
  '.github/workflows/browser-release-evidence.yml',
  '.github/workflows/assistive-worker-ci.yml',
  '.github/workflows/zero-cost-staging-monitoring.yml',
];
const DOCKERFILES = [
  'apps/assistive-worker/Dockerfile.hosted',
  'apps/assistive-worker/Dockerfile.dispatcher',
  'infra/participant-reminders/Dockerfile',
];
const WORKSPACE_PACKAGES = ['package.json', 'apps/admin-cms/package.json', 'apps/public-layer/package.json'];
const escapedBaseline = NODE_24_BASELINE_VERSION.replace(/\./g, '\\.');

describe('Node 24 toolchain baseline', () => {
  it('pins .nvmrc to the baseline', () => {
    expect(read('.nvmrc').trim()).toBe(NODE_24_BASELINE_VERSION);
  });

  it('declares the same engines range in every workspace package and the lockfile', () => {
    for (const relative of WORKSPACE_PACKAGES) {
      const engines = readJson(relative).engines as Record<string, string>;
      expect(engines.node, relative).toBe(NODE_24_RANGE_LABEL);
      expect(engines.npm, relative).toBe('>=11.11.0 <12');
    }
    expect(readJson('package.json').packageManager).toBe('npm@11.11.0');
    const lock = readJson('package-lock.json') as { packages: Record<string, { engines?: Record<string, string> }> };
    for (const key of ['', 'apps/admin-cms', 'apps/public-layer']) {
      expect(lock.packages[key]?.engines?.node, `package-lock.json packages[${JSON.stringify(key)}]`).toBe(NODE_24_RANGE_LABEL);
    }
  });

  it('uses exactly the baseline in every maintained workflow setup step', () => {
    for (const relative of WORKFLOWS) {
      const content = read(relative);
      const versions = [...content.matchAll(/node-version:\s*'?"?([0-9.]+)'?"?/g)].map((match) => match[1]);
      expect(versions.length, relative).toBeGreaterThan(0);
      expect(new Set(versions), relative).toEqual(new Set([NODE_24_BASELINE_VERSION]));
      expect(content, relative).not.toMatch(new RegExp(`Setup Node\\.js (?!${escapedBaseline})[0-9.]+`));
    }
  });

  it('builds every maintained image from the baseline bookworm-slim tag', () => {
    for (const relative of DOCKERFILES) {
      const tags = [...read(relative).matchAll(/FROM node:([0-9.]+)-bookworm-slim/g)].map((match) => match[1]);
      expect(tags.length, relative).toBeGreaterThan(0);
      expect(new Set(tags), relative).toEqual(new Set([NODE_24_BASELINE_VERSION]));
    }
  });

  it('pins and asserts npm 11.11.0 in every Docker build stage that runs npm', () => {
    for (const relative of DOCKERFILES) {
      const stages = read(relative).split(/^FROM /m).slice(1);
      expect(stages.length, relative).toBeGreaterThan(0);
      for (const stage of stages) {
        const lines = stage.split(/\r?\n/);
        const npmLines = lines.map((line, index) => ({ line, index })).filter(({ line }) => /^RUN .*\bnpm\b/.test(line));
        if (npmLines.length === 0) continue; // runtime-only stage: no package manager needed
        const pinIndex = lines.findIndex((line) => line.startsWith(`RUN ${NPM_PIN_COMMAND} && test "$(npm -v)" = "${NPM_PIN}"`));
        expect(pinIndex, `${relative}: stage "${lines[0]}" runs npm without the exact pin+assert`).toBeGreaterThanOrEqual(0);
        for (const { line, index } of npmLines) {
          if (index === pinIndex) continue;
          expect(index, `${relative}: "${line}" runs before the npm pin`).toBeGreaterThan(pinIndex);
        }
      }
    }
  });

  it('pins and asserts npm 11.11.0 before the first npm command in every workflow job that uses npm', () => {
    const workflowDirectory = path.join(repoRoot, '.github/workflows');
    for (const file of fs.readdirSync(workflowDirectory).filter((name) => name.endsWith('.yml'))) {
      const document = yaml.load(read(`.github/workflows/${file}`)) as { jobs?: Record<string, { steps?: Array<{ name?: string; run?: string; uses?: string }> }> };
      for (const [jobId, job] of Object.entries(document.jobs ?? {})) {
        const steps = job.steps ?? [];
        const runs = steps.map((step, index) => ({ run: String(step.run ?? ''), index }));
        const npmSteps = runs.filter(({ run }) => /(^|[^A-Za-z0-9_./-])npm\b/.test(run));
        if (npmSteps.length === 0) continue;
        const location = `.github/workflows/${file} job ${jobId}`;
        const pin = runs.find(({ run }) => run.trim() === NPM_PIN_COMMAND);
        expect(pin, `${location}: uses npm without "${NPM_PIN_COMMAND}"`).toBeDefined();
        const assertion = runs.find(({ run }) => run.includes("execSync('npm -v')") && run.includes(`'${NPM_PIN}'`) && run.includes('process.exit(1)'));
        expect(assertion, `${location}: uses npm without an exact npm version assertion`).toBeDefined();
        expect(assertion!.index, `${location}: the npm assertion must follow the pin`).toBeGreaterThan(pin!.index);
        for (const { run, index } of npmSteps) {
          if (index === pin!.index || index === assertion!.index) continue;
          expect(index, `${location}: "${run.split('\n')[0]}" runs before the npm pin and assertion`).toBeGreaterThan(assertion!.index);
        }
      }
    }
  });

  it('records the baseline in the staging deployment manifest', () => {
    expect(read('infra/deployment/admin-cms-staging.manifest.yaml')).toMatch(
      new RegExp(`\\n\\s+version: ${escapedBaseline}\\n`),
    );
  });
});
