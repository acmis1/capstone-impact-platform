import { describe, expect, it } from 'vitest';
import { passedPackageRules } from './correctionValidation';

describe('complete-package flag revalidation', () => {
  it('resolves only known rules at their exact field and keeps a still-present recommendation open', () => {
    const checks = passedPackageRules({ valid: true, errors: [], warnings: [
      { ruleCode: 'RECOMMENDED_FIELD_MISSING', fieldName: 'accessibilityText', message: 'Still missing.' },
      { ruleCode: 'FILE_MISSING_RECOMMENDED', message: 'No supporting images.' },
    ] });
    expect(checks).toContainEqual({ ruleCode: 'METADATA_MISSING_TITLE', fieldName: 'title' });
    expect(checks).toContainEqual({ ruleCode: 'RECOMMENDED_FIELD_MISSING', fieldName: 'posterText' });
    expect(checks).not.toContainEqual({ ruleCode: 'RECOMMENDED_FIELD_MISSING', fieldName: 'accessibilityText' });
    expect(checks.some((c) => c.ruleCode === 'FILE_MISSING_RECOMMENDED')).toBe(false);
    expect(checks.some((c) => c.ruleCode === 'STAFF_GOVERNANCE_REVIEW')).toBe(false);
  });
  it('cannot record passed rules from an invalid package', () => {
    expect(passedPackageRules({ valid: false, errors: [{ ruleCode: 'METADATA_MISSING_TITLE', fieldName: 'title', message: 'Missing.' }], warnings: [] })).toEqual([]);
  });
});
