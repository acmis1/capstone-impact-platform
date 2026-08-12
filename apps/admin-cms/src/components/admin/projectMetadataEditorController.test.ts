import { describe, expect, it } from 'vitest';
import { invokeProjectMetadataSave } from './projectMetadataEditorController';

describe('project metadata editor action controller', () => {
  it('maps a rejected Server Action promise to a safe result while preserving caller-owned draft state', async () => {
    const result = await invokeProjectMetadataSave(async () => { throw new Error('raw database failure'); }, { title: 'Retained draft' });
    expect(result).toEqual({ ok: false, code: 'INTERNAL_FAILURE', message: 'We could not save your changes. Please try again.' });
  });
});
