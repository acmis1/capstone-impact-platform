import { describe, expect, it } from 'vitest';
import {
  checkTerminology,
  frozenSyntheticOcrEvidence,
  prohibited,
} from './repositoryChecks';

const prohibitedWord = ['stu', 'dent'].join('');
const prohibitedWordPlural = ['stu', 'dents'].join('');

describe('repositoryChecks terminology gating', () => {
  describe('frozenSyntheticOcrEvidence regex policy', () => {
    it('exempts the exact immutable holdout-capture.json path', () => {
      expect(
        frozenSyntheticOcrEvidence.test(
          'docs/assistive-validation/evidence/ocr-iteration2-fresh-holdout/holdout-capture.json',
        ),
      ).toBe(true);
    });

    it('exempts existing synthetic calibration and corpus evidence paths', () => {
      expect(
        frozenSyntheticOcrEvidence.test(
          'tools/assistive-validation-benchmark/ocr-productionization/corpus/calibration.json',
        ),
      ).toBe(true);
      expect(
        frozenSyntheticOcrEvidence.test(
          'tools/assistive-validation-benchmark/ocr-iteration2-fresh-holdout/corpus/holdout.json',
        ),
      ).toBe(true);
      expect(
        frozenSyntheticOcrEvidence.test(
          'docs/assistive-validation/evidence/ocr-productionization-report.json',
        ),
      ).toBe(true);
    });

    it('does NOT exempt neighboring files or unrelated paths in docs/assistive-validation', () => {
      expect(
        frozenSyntheticOcrEvidence.test(
          'docs/assistive-validation/evidence/ocr-iteration2-fresh-holdout/holdout-report.json',
        ),
      ).toBe(false);
      expect(
        frozenSyntheticOcrEvidence.test(
          'docs/assistive-validation/evidence/ocr-iteration2-fresh-holdout/one-shot-state.json',
        ),
      ).toBe(false);
      expect(
        frozenSyntheticOcrEvidence.test(
          'docs/assistive-validation/evidence/ocr-iteration2-fresh-holdout/result-evidence.json',
        ),
      ).toBe(false);
      expect(
        frozenSyntheticOcrEvidence.test(
          'docs/assistive-validation/evidence/other.json',
        ),
      ).toBe(false);
      expect(
        frozenSyntheticOcrEvidence.test('docs/first-contribution.md'),
      ).toBe(false);
      expect(
        frozenSyntheticOcrEvidence.test('apps/admin-cms/src/index.ts'),
      ).toBe(false);
    });
  });

  describe('checkTerminology positive and negative regression evaluation', () => {
    it('passes cleanly on the current repository, recognizing tracked holdout-capture.json as exempt', () => {
      const failures = checkTerminology();
      expect(failures).toEqual([]);
    }, 30000);

    it('exempts synthetic terminology in holdout-capture.json when simulated', () => {
      const failures = checkTerminology('/mock/repo', {
        trackedFilesProvider: () => [
          'docs/assistive-validation/evidence/ocr-iteration2-fresh-holdout/holdout-capture.json',
        ],
        fileReader: () =>
          Buffer.from(`contains synthetic ${prohibitedWord} benchmark text on line 1`),
      });
      expect(failures).toEqual([]);
    });

    it('rejects prohibited terminology in neighboring non-exempt evidence or documentation files', () => {
      const failures = checkTerminology('/mock/repo', {
        trackedFilesProvider: () => [
          'docs/assistive-validation/evidence/ocr-iteration2-fresh-holdout/holdout-report.json',
        ],
        fileReader: () =>
          Buffer.from(
            `header line\nline containing ${prohibitedWord} project data\nfooter line`,
          ),
      });
      expect(failures).toEqual([
        'docs/assistive-validation/evidence/ocr-iteration2-fresh-holdout/holdout-report.json:2',
      ]);
    });

    it('rejects prohibited terminology in file names', () => {
      const failures = checkTerminology('/mock/repo', {
        trackedFilesProvider: () => [`docs/${prohibitedWordPlural}-guide.md`],
        fileReader: () => Buffer.from('clean content'),
      });
      expect(failures).toContain(`docs/${prohibitedWordPlural}-guide.md: filename`);
    });

    it('preserves the strict prohibited regex pattern', () => {
      expect(prohibited.test(prohibitedWord)).toBe(true);
      expect(prohibited.test(prohibitedWordPlural.toUpperCase())).toBe(true);
      expect(prohibited.test('participant')).toBe(false);
      expect(prohibited.test('project')).toBe(false);
    });
  });
});
