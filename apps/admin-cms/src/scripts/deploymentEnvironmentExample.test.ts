import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDeploymentManifest } from './checkDeploymentManifest';

type Entry = {
  name: string;
  value: unknown;
  source?: string;
  secret?: boolean;
};

const root = path.resolve(__dirname, '../../../../');
const example = fs.readFileSync(path.join(root, 'apps/admin-cms/.env.example'), 'utf8');
const manifest = loadDeploymentManifest(root);
const entries = manifest.environment as Entry[];
const platformEntries = manifest.platformEnvironment as Entry[];

function parseActiveAssignments(source: string): Map<string, string[]> {
  const active = new Map<string, string[]>();
  for (const line of source.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const values = active.get(match[1]) ?? [];
    values.push(match[2]);
    active.set(match[1], values);
  }
  return active;
}

function firstAssignmentLineIndex(lines: string[], name: string): number {
  return lines.findIndex((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    return !!(match && match[1] === name);
  });
}

function removeActiveAssignment(source: string, name: string): string {
  const lines = source.split(/\r?\n/);
  const index = firstAssignmentLineIndex(lines, name);
  if (index < 0) return source;
  lines.splice(index, 1);
  return lines.join('\n');
}

function duplicateActiveAssignment(source: string, name: string): string {
  const lines = source.split(/\r?\n/);
  const index = firstAssignmentLineIndex(lines, name);
  if (index < 0) return source;
  lines.splice(index + 1, 0, lines[index]);
  return lines.join('\n');
}

function commentOnlyAssignment(source: string, name: string): string {
  const lines = source.split(/\r?\n/);
  const index = firstAssignmentLineIndex(lines, name);
  if (index < 0) return source;
  lines[index] = `# ${lines[index]}`;
  return lines.join('\n');
}

function forceTrueValue(source: string, name: string): string {
  const lines = source.split(/\r?\n/);
  const index = firstAssignmentLineIndex(lines, name);
  if (index < 0) return source;
  lines[index] = `${name}=true`;
  return lines.join('\n');
}

function inspectExample(source: string, declared: readonly Entry[]): string[] {
  const failures: string[] = [];
  const active = parseActiveAssignments(source);
  for (const entry of declared) {
    const matches = active.get(entry.name) ?? [];
    if (matches.length !== 1) {
      failures.push(`${entry.name}: expected exactly one example assignment`);
      continue;
    }
    if (entry.value === false && matches[0] !== 'false') {
      failures.push(`${entry.name}: must remain disabled`);
    }
    if ((entry.secret === true || entry.source === 'owner-config' || entry.source === 'owner-secret-store')
        && matches[0] !== '') {
      failures.push(`${entry.name}: owner-supplied or secret value must remain blank`);
    }
    if (entry.source === 'fixed-safe-value' || entry.source === 'fixed-safe-default') {
      if (matches[0] !== String(entry.value)) {
        failures.push(`${entry.name}: fixed safe value is inconsistent`);
      }
    }
  }
  return failures;
}

function inspectProviderAssignments(source: string, declared: readonly Entry[]): string[] {
  const active = parseActiveAssignments(source);
  return declared
    .filter((entry) => active.has(entry.name))
    .map((entry) => `${entry.name}: provider identity must not be assigned in the web example`);
}

describe('hosted deployment environment handoff example', () => {
  it('documents every web-manifest variable once and preserves safe defaults', () => {
    expect(inspectExample(example, entries)).toEqual([]);
  });

  it('rejects removed assignments for manifest variables', () => {
    const removedName = entries[0].name;
    expect(inspectExample(removeActiveAssignment(example, removedName), entries)).toContain(
      `${removedName}: expected exactly one example assignment`,
    );
  });

  it('rejects duplicate assignments for manifest variables', () => {
    const duplicateName = entries[1]?.name ?? entries[0].name;
    expect(inspectExample(duplicateActiveAssignment(example, duplicateName), entries)).toContain(
      `${duplicateName}: expected exactly one example assignment`,
    );
  });

  it('rejects true values for manifest false flags', () => {
    const falseName = entries.find((entry) => entry.value === false)?.name;
    if (!falseName) throw new Error('manifest has no disabled capability');
    expect(inspectExample(forceTrueValue(example, falseName), entries)).toContain(
      `${falseName}: must remain disabled`,
    );
  });

  it('rejects manifest variables that are only commented', () => {
    const commentedName = entries.find((entry) => entry.value === false)?.name;
    if (!commentedName) throw new Error('manifest has no disabled capability');
    expect(inspectExample(commentOnlyAssignment(example, commentedName), entries)).toContain(
      `${commentedName}: expected exactly one example assignment`,
    );
  });

  it('keeps owner values blank and fixed safe values exact', () => {
    const failures = inspectExample(example, entries);
    expect(failures).toEqual([]);
    expect(parseActiveAssignments(example).get('CAPSTONE_RUNTIME_ENV')).toEqual(['staging']);
  });

  it('does not represent provider-injected Render identity as example configuration', () => {
    expect(inspectProviderAssignments(example, platformEntries)).toEqual([]);

    const fabricated = `${example}\nRENDER_GIT_COMMIT=${'a'.repeat(40)}\n`;
    expect(inspectProviderAssignments(fabricated, platformEntries)).toContain(
      'RENDER_GIT_COMMIT: provider identity must not be assigned in the web example',
    );
  });

  it('keeps production controls explicit and disabled without turning runner-only values into web config', () => {
    const active = parseActiveAssignments(example);
    expect(active.get('CAPSTONE_PRODUCTION_PUBLICATION_ENABLED')).toEqual(['false']);
    expect(active.get('CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED')).toEqual(['false']);
    expect(active.get('CAPSTONE_PRODUCTION_REMINDERS_ENABLED')).toEqual(['false']);
    expect(active.has('CAPSTONE_PRODUCTION_REMINDERS_ACKNOWLEDGEMENT')).toBe(false);
    expect(example).toContain('# CAPSTONE_PRODUCTION_REMINDERS_ACKNOWLEDGEMENT=');
  });

  it('does not commit real-looking hosts, credentials, tokens or provider identifiers', () => {
    expect(example).not.toMatch(/https?:\/\/[^\s#]+/);
    expect(example).not.toMatch(/sb_(?:secret|publishable)_[A-Za-z0-9]/);
    expect(example).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(example).not.toMatch(/^RENDER(?:_GIT_COMMIT|_EXTERNAL_URL)?=/m);
  });
});
