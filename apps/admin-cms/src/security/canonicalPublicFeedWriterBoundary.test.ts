import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = path.resolve(__dirname, '..');

function productionFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'scripts' || entry.name === 'test' ? [] : productionFiles(absolute);
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

describe('canonical public feed writer boundary', () => {
  it('has exactly one production import of the private canonical Storage primitive', () => {
    const imports = productionFiles(src).filter((file) => fs.readFileSync(file, 'utf8').includes('publicFeedStorage.private'));
    expect(imports.map((file) => path.relative(src, file).replaceAll('\\', '/'))).toEqual([
      'projects/publicFeedWriterCoordinator.ts',
    ]);
    expect(fs.existsSync(path.join(src, 'storage/publicFeedStorage.ts'))).toBe(false);
  });

  it('keeps publication/removal composition on the deployed head and activation as the only full projection', () => {
    const publication = fs.readFileSync(path.join(src, 'projects/controlledPublicationService.ts'), 'utf8');
    const removal = fs.readFileSync(path.join(src, 'projects/controlledPublicRemovalService.ts'), 'utf8');
    const activation = fs.readFileSync(path.join(src, 'projects/publicFeedHistoryService.ts'), 'utf8');
    expect(publication).toContain('composePublicFeedPublication');
    expect(removal).toContain('composePublicFeedRemoval');
    expect(publication).not.toContain('compilePublicFeed(');
    expect(removal).not.toContain('compilePublicFeed(');
    expect(activation).toContain('createPublicFeedArtifact(compilePublicFeed(projects))');
  });

  it('keeps public media promotion behind the durable write-intent boundary', () => {
    const coordinator = fs.readFileSync(path.join(src, 'projects/publicFeedWriterCoordinator.ts'), 'utf8');
    expect(coordinator).not.toContain('beforeCanonicalWrite');
    // Every promotion call site is reached only after mark_public_feed_write_started has
    // revalidated permission, readiness and owner epoch/token for this request.
    const promotions = [...coordinator.matchAll(/promoteMedia\(operation\.id, mediaManifest\)/g)];
    expect(promotions).toHaveLength(4);
    for (const promotion of promotions) {
      const preceding = coordinator.slice(0, promotion.index);
      expect(preceding).toMatch(/markWriteStarted|stored\?\.content === candidate\.content/);
    }
  });

  it('exposes no reverse compensation path for public media', () => {
    const promotion = fs.readFileSync(path.join(src, 'projects/boundPublicMediaPromotion.ts'), 'utf8');
    const publication = fs.readFileSync(path.join(src, 'projects/controlledPublicationService.ts'), 'utf8');
    for (const source of [promotion, publication]) {
      expect(source).not.toContain('removeObjects');
      expect(source).not.toMatch(/\.remove\(/);
    }
  });

  it('resolves idempotent completion evidence from immutable per-target history', () => {
    const publication = fs.readFileSync(path.join(src, 'projects/controlledPublicationService.ts'), 'utf8');
    const removal = fs.readFileSync(path.join(src, 'projects/controlledPublicRemovalService.ts'), 'utf8');
    expect(publication).toContain('findPublicationCompletionEvidence');
    expect(removal).toContain('findRemovalCompletionEvidence');
    for (const source of [publication, removal]) {
      expect(source).not.toContain('currentVersion.operationId');
      expect(source).not.toContain('currentVersion.auditRecordId');
      expect(source).not.toContain('currentVersion.publishedSnapshotId');
    }
  });

  it('leaves the standalone staging publisher permanently fail closed', () => {
    const legacy = fs.readFileSync(path.join(src, 'scripts/publishStagingFeed.ts'), 'utf8');
    expect(legacy).toContain('LEGACY_CANONICAL_WRITER_DISABLED');
    expect(legacy).not.toMatch(/\.storage\.from\(|\.upload\(/);
  });
});
