import { describe, expect, it, vi } from 'vitest';
import { ProjectMetadataInput, ProjectMetadataView } from './projectMetadata';
import { ProjectMetadataGateway, SupabaseProjectMetadataGateway, loadProjectMetadataEditorData, resolveUniqueLookupId, saveProjectMetadata } from './projectMetadataService';

const ids = { program: 'a0000000-0000-4000-8000-000000000001', discipline: 'b0000000-0000-4000-8000-000000000001', category: 'c0000000-0000-4000-8000-000000000001' };
const input: ProjectMetadataInput = { publicId: 'synthetic-project', title: 'Updated title', summary: 'Updated summary', background: 'Updated background', solution: 'Updated solution', year: 2026, programId: ids.program, disciplineIds: [ids.discipline], industryCategoryIds: [ids.category], expectedUpdatedAt: '2026-01-01T00:00:00.000Z' };
const metadata: ProjectMetadataView = { ...input, year: '2026' };

class FakeGateway implements ProjectMetadataGateway {
  calls: string[] = [];
  response: unknown = { resultCode: 'SUCCESS', metadata };
  options = { programs: [{ id: ids.program, name: 'Program' }], disciplines: [{ id: ids.discipline, name: 'Discipline' }], industryCategories: [{ id: ids.category, name: 'Industry' }] };
  async loadProject() { return { ...metadata, id: 'd0000000-0000-4000-8000-000000000001' }; }
  async loadOptions() { this.calls.push('lookups'); return this.options; }
  async updateMetadataAtomically() { this.calls.push('rpc'); return this.response; }
}

describe('project metadata atomic persistence workflow', () => {
  it('uses exactly one metadata mutation after lookup validation', async () => {
    const gateway = new FakeGateway();
    expect(await saveProjectMetadata(gateway, metadata)).toEqual({ ok: true, metadata });
    expect(gateway.calls).toEqual(['lookups', 'rpc']);
  });
  it('accepts a successful RPC response containing PostgreSQL UUID-shaped lookup IDs', async () => {
    const zeroVersion = 'a0000000-0000-0000-0000-000000000001';
    const gateway = new FakeGateway();
    const zeroVersionMetadata = {
      ...metadata,
      programId: zeroVersion,
      disciplineIds: [zeroVersion],
      industryCategoryIds: [zeroVersion],
    };
    gateway.options = {
      programs: [{ id: zeroVersion, name: 'Program' }],
      disciplines: [{ id: zeroVersion, name: 'Discipline' }],
      industryCategories: [{ id: zeroVersion, name: 'Industry' }],
    };
    gateway.response = { resultCode: 'SUCCESS', metadata: zeroVersionMetadata };
    expect(await saveProjectMetadata(gateway, zeroVersionMetadata)).toEqual({ ok: true, metadata: zeroVersionMetadata });
  });
  it('does not expose the database-only project id to the strict editor mutation payload', async () => {
    const gateway = new FakeGateway();
    const editorData = await loadProjectMetadataEditorData(gateway, metadata.publicId);
    expect(editorData).toEqual({ metadata, ...gateway.options });
    expect(editorData?.metadata).not.toHaveProperty('id');
  });
  it.each([
    ['programId', { programId: 'a0000000-0000-4000-8000-000000000002' }],
    ['disciplineIds', { disciplineIds: ['b0000000-0000-4000-8000-000000000002'] }],
    ['industryCategoryIds', { industryCategoryIds: ['c0000000-0000-4000-8000-000000000002'] }],
  ])('attributes unsupported %s without calling the RPC', async (field, patch) => {
    const gateway = new FakeGateway(); const result = await saveProjectMetadata(gateway, { ...metadata, ...patch });
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', fieldErrors: { [field]: expect.any(Array) } });
    expect(gateway.calls).toEqual(['lookups']);
  });
  it.each(['PROJECT_NOT_FOUND', 'STALE_VERSION', 'VALIDATION_FAILED', 'APPROVAL_REOPEN_REQUIRED', 'PUBLISHED_PROJECT_LOCKED'])('maps expected RPC result %s safely', async (resultCode) => {
    const gateway = new FakeGateway(); gateway.response = { resultCode };
    expect(await saveProjectMetadata(gateway, metadata)).toMatchObject({ ok: false, code: resultCode });
  });
  it('rejects malformed or unknown RPC responses and hides raw RPC errors', async () => {
    const malformed = new FakeGateway(); malformed.response = { resultCode: 'SUCCESS' };
    expect(await saveProjectMetadata(malformed, metadata)).toMatchObject({ code: 'INTERNAL_FAILURE' });
    const unknown = new FakeGateway(); unknown.response = { resultCode: 'UNSAFE_UNKNOWN' };
    expect(await saveProjectMetadata(unknown, metadata)).toMatchObject({ code: 'INTERNAL_FAILURE' });
    const failure = new FakeGateway(); failure.updateMetadataAtomically = async () => { throw new Error('raw backend detail'); };
    const result = await saveProjectMetadata(failure, metadata);
    expect(result).toMatchObject({ code: 'PERSISTENCE_FAILED' });
    if (!result.ok) expect(result.message).not.toContain('raw backend detail');
  });
  it('maps exactly one RPC name and exact allowed parameters', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { resultCode: 'SUCCESS', metadata }, error: null });
    const gateway = new SupabaseProjectMetadataGateway({ rpc } as never);
    await gateway.updateMetadataAtomically(input);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('update_project_metadata', {
      p_public_id: input.publicId, p_title: input.title, p_summary: input.summary, p_background: input.background, p_solution: input.solution,
      p_year: input.year, p_program_id: input.programId, p_discipline_ids: input.disciplineIds, p_industry_category_ids: input.industryCategoryIds, p_expected_updated_at: input.expectedUpdatedAt,
    });
  });
  it('uses scalar-name fallback only for an exact unique lookup match', () => {
    const options = [{ id: ids.program, name: 'Program' }];
    expect(resolveUniqueLookupId(options, 'Program')).toBe(ids.program);
    expect(resolveUniqueLookupId(options, 'Missing')).toBe('');
    expect(resolveUniqueLookupId([...options, { id: 'a0000000-0000-4000-8000-000000000002', name: 'Program' }], 'Program')).toBe('');
  });
});
