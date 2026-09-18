import { describe, expect, it } from 'vitest';
import {
  validateSoftDeleteExecutionInput,
  validateSoftDeletePreflightInput,
} from './projectSoftDeleteInput';

describe('project soft delete input boundary', () => {
  it('accepts one to 50 unique safe public IDs and rejects duplicates or oversized selections', () => {
    expect(validateSoftDeletePreflightInput({ publicIds: ['project-1'] }).valid).toBe(true);
    expect(validateSoftDeletePreflightInput({ publicIds: Array.from({ length: 50 }, (_, index) => `project-${index}`) }).valid).toBe(true);
    expect(validateSoftDeletePreflightInput({ publicIds: [] }).valid).toBe(false);
    expect(validateSoftDeletePreflightInput({ publicIds: Array.from({ length: 51 }, (_, index) => `project-${index}`) }).valid).toBe(false);
    expect(validateSoftDeletePreflightInput({ publicIds: ['same', 'same'] }).valid).toBe(false);
    expect(validateSoftDeletePreflightInput({ publicIds: ['bad/id'] }).valid).toBe(false);
  });

  it('rejects browser-supplied identity and unexpected fields', () => {
    expect(validateSoftDeletePreflightInput({ publicIds: ['project-1'], adminId: 'spoofed' }).valid).toBe(false);
    expect(validateSoftDeleteExecutionInput({ expectedUpdatedAt: '2026-09-17T00:00:00.000Z', adminId: 'spoofed' }, 'project-1').valid).toBe(false);
  });

  it('requires a safe path ID and a parseable expected version', () => {
    expect(validateSoftDeleteExecutionInput({ expectedUpdatedAt: '2026-09-17T00:00:00.000Z' }, 'project-1')).toEqual({
      valid: true,
      data: { publicId: 'project-1', expectedUpdatedAt: '2026-09-17T00:00:00.000Z' },
    });
    expect(validateSoftDeleteExecutionInput({ expectedUpdatedAt: 'not-a-date' }, 'project-1').valid).toBe(false);
    expect(validateSoftDeleteExecutionInput({}, 'project-1').valid).toBe(false);
    expect(validateSoftDeleteExecutionInput({ expectedUpdatedAt: '2026-09-17T00:00:00.000Z' }, 'bad/id').valid).toBe(false);
  });
});
