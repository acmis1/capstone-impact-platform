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
    ['rollback enabled', (manifest: TestManifest) => {
      environmentEntry(manifest, 'CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED').value = true;
    }],
    ['secret value', (manifest: TestManifest) => {
      environmentEntry(manifest, 'SUPABASE_SECRET_KEY').value = 'test-secret-placeholder';
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

describe('deployment environment completeness and provider ownership', () => {
  it.each([
    'CAPSTONE_STAGING_PUBLICATION_ENABLED',
    'CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED',
    'STAFF_PROVISIONING_ENABLED',
    'CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED',
    'GEMINI_ASSISTIVE_EXTRACTION_ENABLED',
  ])(
    'rejects silently removing the disabled capability %s', name => {
      const manifest = manifestCopy();
      manifest.environment = (manifest.environment as TestManifest[]).filter(entry => entry.name !== name);
      expect(verifyDeploymentManifest(repoRoot, manifest)).toContain(`environment: missing ${name}`);
    },
  );

  it.each(['RENDER', 'RENDER_GIT_COMMIT', 'RENDER_EXTERNAL_URL'])(
    'requires provider identity %s without fabricating it', name => {
      const manifest = manifestCopy();
      manifest.platformEnvironment = (manifest.platformEnvironment as TestManifest[])
        .filter(entry => entry.name !== name);
      expect(verifyDeploymentManifest(repoRoot, manifest)).toContain(`platformEnvironment: missing ${name}`);
    },
  );

  it('rejects a hardcoded provider identity', () => {
    const manifest = manifestCopy();
    (manifest.platformEnvironment as TestManifest[])[0].value = 'true';
    expect(verifyDeploymentManifest(repoRoot, manifest).some(error =>
      error.includes('provider-injected without a stored value')
      || error.includes('must remain null'),
    )).toBe(true);
  });

  it('rejects provider identity in owner configuration even with a null value', () => {
    const manifest = manifestCopy();
    (manifest.environment as TestManifest[]).push({ name: 'RENDER_GIT_COMMIT', value: null, source: 'owner-config' });
    expect(verifyDeploymentManifest(repoRoot, manifest)).toContain(
      'environment.RENDER_GIT_COMMIT: provider identity must not become owner-supplied configuration',
    );
  });

  it('rejects production capability configuration from the staging manifest', () => {
    const manifest = manifestCopy();
    (manifest.environment as TestManifest[]).push({
      name: 'CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED',
      value: false,
      source: 'fail-closed-default',
    });
    expect(verifyDeploymentManifest(repoRoot, manifest)).toContain(
      'environment.CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED: unexpected staging web variable',
    );
  });

  it('requires the platform identity consumer paths to remain source-backed', () => {
    const manifest = manifestCopy();
    const render = (manifest.platformEnvironment as TestManifest[])
      .find((entry) => entry.name === 'RENDER');
    if (!render) throw new Error('missing RENDER platform environment entry');
    render.consumer = 'apps/admin-cms/src/auth/csrf.ts';
    expect(verifyDeploymentManifest(repoRoot, manifest)).toContain(
      'platformEnvironment.RENDER: current consumer must be documented',
    );
  });
});
