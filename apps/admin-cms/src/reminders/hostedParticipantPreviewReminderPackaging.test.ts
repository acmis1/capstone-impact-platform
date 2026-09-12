import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');
const packagingRoot = path.resolve(repoRoot, 'infra/participant-reminders');

describe('participant preview reminder hosted packaging', () => {
  it('provides a local-build Docker profile with no ingress or horizontal-scaling declaration', () => {
    const dockerfile = fs.readFileSync(path.join(packagingRoot, 'Dockerfile'), 'utf8');
    const compose = fs.readFileSync(path.join(packagingRoot, 'compose.yaml'), 'utf8');

    expect(dockerfile).toContain('node:24.14.1-bookworm-slim');
    expect(dockerfile).toContain('build:participant-preview-reminder-runner');
    expect(dockerfile).not.toMatch(/^\s*EXPOSE\s+/im);
    expect(compose).not.toMatch(/^\s*ports:\s*$/im);
    expect(compose).not.toMatch(/^\s*deploy:\s*$/im);
    expect(compose).toContain('PARTICIPANT_PREVIEW_REMINDERS_ENV_FILE');
    expect(compose).toContain('CAPSTONE_EXPECTED_SUPABASE_PROJECT_REF: ${CAPSTONE_EXPECTED_SUPABASE_PROJECT_REF-}');
    expect(compose).toContain('CAPSTONE_STAGING_MUTATION_CONFIRMATION: ${CAPSTONE_STAGING_MUTATION_CONFIRMATION-}');
    expect(compose).toContain('restart: on-failure');
  });

  it('keeps the example environment file name-only', () => {
    const example = fs.readFileSync(
      path.join(packagingRoot, 'participant-reminders.env.example'),
      'utf8',
    );
    const variableNames = example
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    expect(variableNames.length).toBeGreaterThan(0);
    expect(variableNames.every((line) => /^[A-Z][A-Z0-9_]*=$/.test(line))).toBe(true);
    expect(example).not.toContain('https://');
    expect(example).not.toContain('@');
  });

  it('provides a separate fail-closed production profile without changing staging guards', () => {
    const staging = fs.readFileSync(path.join(packagingRoot, 'compose.yaml'), 'utf8');
    const production = fs.readFileSync(path.join(packagingRoot, 'compose.production.yaml'), 'utf8');
    const example = fs.readFileSync(
      path.join(packagingRoot, 'participant-reminders.production.env.example'),
      'utf8',
    );

    expect(staging).toContain('CAPSTONE_STAGING_MUTATION_CONFIRMATION');
    expect(staging).not.toContain('CAPSTONE_PRODUCTION_REMINDERS_ENABLED');
    expect(production).toContain('CAPSTONE_RUNTIME_ENV: production');
    expect(production).toContain('CAPSTONE_PRODUCTION_REMINDERS_ENABLED: ${CAPSTONE_PRODUCTION_REMINDERS_ENABLED-}');
    expect(production).toContain('CAPSTONE_PRODUCTION_REMINDERS_ACKNOWLEDGEMENT: ${CAPSTONE_PRODUCTION_REMINDERS_ACKNOWLEDGEMENT-}');
    expect(production).not.toContain('CAPSTONE_STAGING_MUTATION_CONFIRMATION');
    expect(production).not.toMatch(/^\s*ports:\s*$/im);
    expect(production).not.toMatch(/^\s*deploy:\s*$/im);
    expect(production).toContain('restart: on-failure');
    expect(example.split(/\r?\n/).filter((line) => line && !line.startsWith('#'))
      .every((line) => /^[A-Z][A-Z0-9_]*=$/.test(line))).toBe(true);
  });
});
