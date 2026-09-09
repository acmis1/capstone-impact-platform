import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadDeploymentManifest,
  verifyDeploymentManifest,
} from './checkDeploymentManifest';

const repoRoot = path.resolve(__dirname, '../../../../');
type TestManifest = Record<string, unknown>;

function serviceOf(manifest: TestManifest): TestManifest {
  return manifest.service as TestManifest;
}

function environmentEntry(manifest: TestManifest, name: string): TestManifest {
  const entries = manifest.environment as TestManifest[];
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`missing test environment entry: ${name}`);
  return entry;
}

function manifestCopy(): TestManifest {
  return structuredClone(loadDeploymentManifest(repoRoot)) as TestManifest;
}

describe('admin CMS deployment manifest', () => {
  it('matches the repository deployment and staging safety contract', () => {
    expect(verifyDeploymentManifest(repoRoot)).toEqual([]);
  });

  it.each([
    ['paid plan', (manifest: TestManifest) => { serviceOf(manifest).plan = 'standard'; }],
    ['automatic deploy', (manifest: TestManifest) => { serviceOf(manifest).autoDeploy = true; }],
    ['wrong health path', (manifest: TestManifest) => {
      (serviceOf(manifest).health as TestManifest).path = '/api/health';
    }],
    ['wrong root', (manifest: TestManifest) => { serviceOf(manifest).rootDirectory = 'apps/admin-cms'; }],
    ['wrong runtime', (manifest: TestManifest) => {
      (serviceOf(manifest).runtime as TestManifest).name = 'nodejs';
    }],
    ['publication enabled', (manifest: TestManifest) => {
      environmentEntry(manifest, 'CAPSTONE_STAGING_PUBLICATION_ENABLED').value = true;
    }],
    ['secret value', (manifest: TestManifest) => {
      environmentEntry(manifest, 'SUPABASE_SECRET_KEY').value = 'sb_secret_in_test_only';
    }],
    ['default URL', (manifest: TestManifest) => {
      environmentEntry(manifest, 'NEXT_PUBLIC_SUPABASE_URL').value = 'https://example.invalid';
    }],
  ])('rejects %s', (_name, mutate) => {
    const manifest = manifestCopy();
    mutate(manifest);
    expect(verifyDeploymentManifest(repoRoot, manifest).length).toBeGreaterThan(0);
  });

  it('keeps owner-supplied values absent from the tracked manifest', () => {
    const source = fs.readFileSync(
      path.join(repoRoot, 'infra/deployment/admin-cms-staging.manifest.yaml'),
      'utf8',
    );
    expect(source).not.toMatch(/sb_(?:secret|publishable)_[A-Za-z0-9]/);
    expect(source).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(source).not.toMatch(/https?:\/\/[^\s#]+supabase\.co/);
  });
});
