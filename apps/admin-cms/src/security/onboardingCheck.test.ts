import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  performOnboardingCheck,
  isVersionAtLeast,
  parseSemverMajorMinorPatch,
} from '../scripts/onboardingCheck';

describe('Second-Developer Onboarding Precheck Unit Tests', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');

  it('1. Version parsing correctly parses major.minor.patch strings', () => {
    expect(parseSemverMajorMinorPatch('v20.9.0')).toEqual({ major: 20, minor: 9, patch: 0 });
    expect(parseSemverMajorMinorPatch('24.14.1')).toEqual({ major: 24, minor: 14, patch: 1 });
    expect(parseSemverMajorMinorPatch('10.8.2')).toEqual({ major: 10, minor: 8, patch: 2 });
    expect(parseSemverMajorMinorPatch('invalid')).toBeNull();
  });

  it('2. isVersionAtLeast correctly compares semver boundaries', () => {
    expect(isVersionAtLeast('v20.9.0', '20.9.0')).toBe(true);
    expect(isVersionAtLeast('v20.18.0', '20.9.0')).toBe(true);
    expect(isVersionAtLeast('v24.14.1', '20.9.0')).toBe(true);
    expect(isVersionAtLeast('v20.8.9', '20.9.0')).toBe(false);
    expect(isVersionAtLeast('v18.20.0', '20.9.0')).toBe(false);

    expect(isVersionAtLeast('10.8.2', '10.0.0')).toBe(true);
    expect(isVersionAtLeast('9.9.9', '10.0.0')).toBe(false);
  });

  it('3. performOnboardingCheck passes cleanly when toolchain and filesystem contracts match', () => {
    const mockExec = (cmd: string): string => {
      if (cmd === 'npm -v') return '10.8.2';
      if (cmd === 'docker --version') return 'Docker version 27.0.3, build 7d4cd16';
      if (cmd === 'docker info') return 'Client: Docker Engine...';
      if (cmd === 'git ls-files') return 'README.md\npackage.json\ninfra/supabase/config.toml';
      return '';
    };

    const result = performOnboardingCheck({
      repoRoot,
      execRunner: mockExec,
      nodeVersion: 'v20.18.0',
    });

    expect(result.passed).toBe(true);
    expect(result.items.length).toBe(11);

    const nodeItem = result.items.find((i) => i.name.includes('Node.js Version'));
    expect(nodeItem?.passed).toBe(true);

    const migrationsItem = result.items.find((i) => i.name.includes('Timestamped Database Migrations'));
    expect(migrationsItem?.passed).toBe(true);
    expect(migrationsItem?.message).toContain('7 timestamped migrations');
  });

  it('4. performOnboardingCheck reports FAIL when Node version is lower than 20.9.0', () => {
    const mockExec = (cmd: string): string => {
      if (cmd === 'npm -v') return '10.8.2';
      if (cmd === 'docker --version') return 'Docker version 27.0.3';
      if (cmd === 'docker info') return 'Server running';
      if (cmd === 'git ls-files') return 'README.md';
      return '';
    };

    const result = performOnboardingCheck({
      repoRoot,
      execRunner: mockExec,
      nodeVersion: 'v18.19.0',
    });

    expect(result.passed).toBe(false);
    const nodeItem = result.items.find((i) => i.name.includes('Node.js Version'));
    expect(nodeItem?.passed).toBe(false);
    expect(nodeItem?.message).toContain('does not satisfy >= 20.9.0');
  });

  it('5. performOnboardingCheck reports FAIL when Docker daemon is not reachable', () => {
    const mockExec = (cmd: string): string => {
      if (cmd === 'npm -v') return '10.8.2';
      if (cmd === 'docker --version') return 'Docker version 27.0.3';
      if (cmd === 'docker info') throw new Error('Cannot connect to the Docker daemon');
      if (cmd === 'git ls-files') return 'README.md';
      return '';
    };

    const result = performOnboardingCheck({
      repoRoot,
      execRunner: mockExec,
      nodeVersion: 'v20.18.0',
    });

    expect(result.passed).toBe(false);
    const dockerItem = result.items.find((i) => i.name.includes('Docker Daemon Reachability'));
    expect(dockerItem?.passed).toBe(false);
    expect(dockerItem?.message).toContain('Docker daemon is not reachable');
  });
});
