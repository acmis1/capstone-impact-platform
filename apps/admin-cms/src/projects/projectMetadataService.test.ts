import { describe, expect, it } from 'vitest';
import { ProjectMetadataInput, ProjectMetadataView } from './projectMetadata';
import { ProjectMetadataGateway, saveProjectMetadata } from './projectMetadataService';

const ids = { program: 'a0000000-0000-4000-8000-000000000001', discipline: 'b0000000-0000-4000-8000-000000000001', category: 'c0000000-0000-4000-8000-000000000001' };
const input: ProjectMetadataInput = { publicId: 'synthetic-project', title: 'Updated title', summary: 'Updated summary', background: 'Updated background', solution: 'Updated solution', year: 2026, programId: ids.program, disciplineIds: [ids.discipline], industryCategoryIds: [ids.category], expectedUpdatedAt: '2026-01-01T00:00:00.000Z' };
const metadata: ProjectMetadataView = { ...input, year: '2026' };

class FakeGateway implements ProjectMetadataGateway {
  calls: string[] = [];
  failAt?: string;
  failRestore = false;
  snapshot = { ...metadata, id: 'd0000000-0000-4000-8000-000000000001', scalar: { program_id: ids.program, program_name: 'Program', discipline: 'Discipline', industry: 'Industry' } };
  async loadProject() { this.calls.push('loadProject'); return this.failAt === 'missing' ? null : this.snapshot; }
  async loadOptions() { this.calls.push('loadOptions'); if (this.failAt === 'lookups') throw new Error('fail'); return { programs: [{ id: ids.program, name: 'Program' }], disciplines: [{ id: ids.discipline, name: 'Discipline' }], industryCategories: [{ id: ids.category, name: 'Industry' }] }; }
  async updateScalar() { this.calls.push('scalar'); if (this.failAt === 'stale') return 'stale' as const; if (this.failAt === 'scalar') throw new Error('fail'); return metadata; }
  async replaceDisciplines() { this.calls.push('disciplines'); if (this.failAt === 'disciplines') throw new Error('fail'); }
  async replaceIndustryCategories() { this.calls.push('categories'); if (this.failAt === 'categories') throw new Error('fail'); }
  async restore() { this.calls.push('restore'); if (this.failRestore) throw new Error('fail'); }
}

describe('project metadata persistence workflow', () => {
  it('updates only canonical metadata and both join mappings in order', async () => {
    const gateway = new FakeGateway(); const result = await saveProjectMetadata(gateway, metadata);
    expect(result).toEqual({ ok: true, metadata });
    expect(gateway.calls).toEqual(['loadProject', 'loadOptions', 'scalar', 'disciplines', 'categories']);
  });
  it.each(['disciplines', 'categories'])('returns safe persistence failure and restores snapshot after %s failure', async (failAt) => {
    const gateway = new FakeGateway(); gateway.failAt = failAt; const result = await saveProjectMetadata(gateway, metadata);
    expect(result).toMatchObject({ ok: false, code: 'PERSISTENCE_FAILED' });
    expect(gateway.calls).toContain('restore');
  });
  it('does not roll back a failed base-row write', async () => {
    const gateway = new FakeGateway(); gateway.failAt = 'scalar'; await saveProjectMetadata(gateway, metadata);
    expect(gateway.calls).not.toContain('restore');
  });
  it('maps missing project, stale version, invalid lookup, and rollback failure safely', async () => {
    const missing = new FakeGateway(); missing.failAt = 'missing'; expect(await saveProjectMetadata(missing, metadata)).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    const stale = new FakeGateway(); stale.failAt = 'stale'; expect(await saveProjectMetadata(stale, metadata)).toMatchObject({ code: 'STALE_VERSION' });
    const invalid = new FakeGateway(); expect(await saveProjectMetadata(invalid, { ...metadata, programId: 'a0000000-0000-4000-8000-000000000002' })).toMatchObject({ code: 'VALIDATION_FAILED' });
    const rollback = new FakeGateway(); rollback.failAt = 'categories'; rollback.failRestore = true; expect(await saveProjectMetadata(rollback, metadata)).toMatchObject({ code: 'ROLLBACK_FAILED' });
  });
});
