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

  it('leaves the standalone staging publisher permanently fail closed', () => {
    const legacy = fs.readFileSync(path.join(src, 'scripts/publishStagingFeed.ts'), 'utf8');
    expect(legacy).toContain('LEGACY_CANONICAL_WRITER_DISABLED');
    expect(legacy).not.toMatch(/\.storage\.from\(|\.upload\(/);
  });
});
