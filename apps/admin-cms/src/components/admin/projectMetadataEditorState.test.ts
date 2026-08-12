import { describe, expect, it } from 'vitest';
import { ProjectMetadataView } from '../../projects/projectMetadata';
import { editorCanSubmit, isMetadataDirty } from './projectMetadataEditorState';

const metadata: ProjectMetadataView = { publicId: 'synthetic', title: 'Title', summary: 'Summary', background: '', solution: '', year: '2026', programId: 'a0000000-0000-4000-8000-000000000001', disciplineIds: ['b0000000-0000-4000-8000-000000000001'], industryCategoryIds: ['c0000000-0000-4000-8000-000000000001'], expectedUpdatedAt: '2026-01-01T00:00:00.000Z' };
describe('metadata editor state', () => {
  it('detects dirty state and returns clean after restoring initial values', () => { expect(isMetadataDirty(metadata, { ...metadata, title: 'Changed' })).toBe(true); expect(isMetadataDirty(metadata, { ...metadata })).toBe(false); });
  it('treats valid selection order changes as clean but detects additions and duplicates', () => {
    const two = { ...metadata, disciplineIds: ['b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002'] };
    expect(isMetadataDirty(two, { ...two, disciplineIds: [...two.disciplineIds].reverse() })).toBe(false);
    expect(isMetadataDirty(metadata, two)).toBe(true);
    expect(isMetadataDirty(metadata, { ...metadata, disciplineIds: [metadata.disciplineIds[0], metadata.disciplineIds[0]] })).toBe(true);
  });
  it('suppresses duplicate submits while pending and when clean', () => { expect(editorCanSubmit(true, true)).toBe(false); expect(editorCanSubmit(false, false)).toBe(false); expect(editorCanSubmit(false, true)).toBe(true); });
});
