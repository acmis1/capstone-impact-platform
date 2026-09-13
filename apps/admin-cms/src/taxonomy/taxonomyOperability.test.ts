import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { createPublicFeedArtifact } from '../feed/publicFeedArtifact';
import { createMockProject } from '../test/projectFixtures';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const FAMILY_PROGRAMS = ['IT', 'Engineering', 'Aviation', 'Food Tech', 'Future Program (synthetic evidence)'] as const;

describe('MG-03 named and future programme operability', () => {
  it('keeps all four Project Brief family labels plus a new future value available in local synthetic seed data', async () => {
    const seed = await readFile(path.join(root, 'infra/supabase/seed.sql'), 'utf8');
    for (const program of FAMILY_PROGRAMS) {
      expect(seed).toContain(`'${program}'`);
    }
    expect(seed).toContain('not official School degree names');
  });

  it('projects all family values through the current public feed contract without program-specific code', () => {
    const projects = FAMILY_PROGRAMS.map((program, index) => createMockProject({
      id: index + 1,
      publicId: `mg03-${index + 1}`,
      title: `MG-03 synthetic ${program} project`,
      program,
      studyProgram: program,
      discipline: `${program} discipline`,
      disciplines: [`${program} discipline`],
      industry: `Synthetic ${program} industry`,
      status: 'published',
    }));

    const feed = compilePublicFeed(projects);
    expect(feed.map((record) => record.program)).toEqual(FAMILY_PROGRAMS);
    expect(feed.map((record) => record.disciplines[0])).toEqual(FAMILY_PROGRAMS.map((program) => `${program} discipline`));
    expect(createPublicFeedArtifact(feed).feed).toEqual(feed);
  });

  it('uses the existing strict import catalogue resolution and dynamic public program facets', async () => {
    const [metadataStage, publicLayer] = await Promise.all([
      readFile(path.join(root, 'infra/supabase/migrations/20260810090000_atomic_browser_import_metadata_stage.sql'), 'utf8'),
      readFile(path.join(root, 'apps/public-layer/duda/bodyend.html'), 'utf8'),
    ]);

    expect(metadataStage).toContain('FROM public.programs AS p');
    expect(metadataStage).toContain("'LOOKUP_NOT_FOUND'");
    expect(metadataStage).toContain('program_id');
    expect(metadataStage).toContain('program_name');
    expect(publicLayer).toContain("const prog = String(p.program || p.studyProgram || '').trim();");
    expect(publicLayer).toContain('options.programs.map');
    expect(publicLayer).toContain("currentFilters.program !== 'All'");
  });
});
