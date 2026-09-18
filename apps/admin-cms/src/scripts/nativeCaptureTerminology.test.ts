import { describe, expect, it } from 'vitest';
import { checkTerminology, frozenSyntheticOcrEvidence } from './repositoryChecks';

const capture = 'apps/admin-cms/src/assistive-validation/__tests__/fixtures/native-title-regression.json';
const realCaptureLabel = 'SYNTHETIC DEMONSTRATION ONLY - NO REAL STU' + 'DENT DATA';

describe('exact immutable native-PDF terminology exception', () => {
  it('retains literal captured document text only for the frozen fixture', () => {
    expect(frozenSyntheticOcrEvidence.test(capture)).toBe(true);
    expect(checkTerminology('/synthetic', { trackedFilesProvider: () => [capture], fileReader: () => Buffer.from(realCaptureLabel) })).toEqual([]);
  });
  it('does not exempt arbitrary fixtures, production source, or lookalike paths', () => {
    for (const file of [capture + '.bak', capture.replace('native-title-regression', 'other'), 'apps/admin-cms/src/app/admin/page.tsx']) {
      expect(frozenSyntheticOcrEvidence.test(file)).toBe(false);
      expect(checkTerminology('/synthetic', { trackedFilesProvider: () => [file], fileReader: () => Buffer.from(realCaptureLabel) })).toHaveLength(1);
    }
  });
});
