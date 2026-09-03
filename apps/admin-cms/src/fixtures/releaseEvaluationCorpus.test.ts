import { describe, expect, it } from 'vitest';

import { parseBrowserImportPreview } from '../import/parseBrowserImportPreview';
import {
  buildReleaseEvaluationCorpus,
  countReleaseGalleryDistribution,
  countReleaseLifecycleProfiles,
  countReleasePackageProfiles,
  materializeReleaseEvaluationCorpus,
  RELEASE_EVALUATION_CASE_COUNT,
  RELEASE_EVALUATION_PERSISTED_COUNT,
  RELEASE_EVALUATION_REJECTED_COUNT,
  RELEASE_LIFECYCLE_PROFILES,
  RELEASE_PACKAGE_PROFILES,
} from './releaseEvaluationCorpus';
import { DEFAULT_SYNTHETIC_SEED } from './syntheticProjects';

describe('release evaluation corpus', () => {
  it('has the exact deterministic corpus, profile, gallery, and issue accounting', () => {
    const corpus = buildReleaseEvaluationCorpus(DEFAULT_SYNTHETIC_SEED);
    const repeated = buildReleaseEvaluationCorpus(DEFAULT_SYNTHETIC_SEED);
    const differentSeed = buildReleaseEvaluationCorpus(DEFAULT_SYNTHETIC_SEED + 1);

    expect(corpus).toEqual(repeated);
    expect(corpus.manifestDigest).not.toBe(differentSeed.manifestDigest);
    expect(corpus.cases).toHaveLength(RELEASE_EVALUATION_CASE_COUNT);
    expect(new Set(corpus.cases.map((item) => item.caseId)).size).toBe(RELEASE_EVALUATION_CASE_COUNT);
    expect(corpus.cases.filter((item) => item.expected.persistence === 'persisted')).toHaveLength(RELEASE_EVALUATION_PERSISTED_COUNT);
    expect(corpus.cases.filter((item) => item.expected.persistence === 'rejected')).toHaveLength(RELEASE_EVALUATION_REJECTED_COUNT);

    expect(Object.fromEntries(countReleasePackageProfiles(corpus.cases))).toEqual({
      'xlsx-one-gallery': 55,
      'xlsx-three-gallery': 25,
      'xlsx-maximum-gallery': 10,
      'xlsx-zero-gallery': 10,
      'xlsx-duplicate-team-member': 10,
      'legacy-json-missing-accessibility': 10,
      'xlsx-missing-title': 1,
      'xlsx-invalid-year': 1,
      'admin-reference-field-mismatch': 1,
      'admin-reference-no-match': 1,
      'unknown-database-taxonomy': 1,
      'missing-poster-image': 1,
      'missing-poster-pdf': 1,
      'missing-gallery-alt-text': 1,
      'oversized-gallery-alt-text': 1,
      'duplicate-gallery-position': 1,
      'malformed-xlsx': 1,
      'repeated-existing-public-id': 1,
    });
    expect(Object.fromEntries(countReleaseLifecycleProfiles(corpus.cases))).toEqual({
      'accessibility-blocked-draft': 10,
      'eligible-preflight-only-draft': 10,
      'already-submitted': 10,
      'stale-approval-candidate': 10,
      'already-approved': 10,
      'successful-approval': 45,
      'bulk-request-changes': 10,
      'participant-correction': 5,
      archived: 10,
    });
    expect(countReleaseGalleryDistribution(corpus.cases)).toEqual({ zero: 20, one: 65, multiple: 25, maximum: 10 });

    expect(corpus.seededIssues).toHaveLength(52);
    expect(corpus.seededIssues.filter((issue) => issue.evaluationCriticality === 'critical')).toHaveLength(32);
    expect(corpus.seededIssues.filter((issue) => issue.evaluationCriticality === 'non_critical')).toHaveLength(20);
    expect(corpus.negativeControls).toHaveLength(110);
    expect(corpus.negativeControls.filter((control) => control.description.includes('not blocked'))).toHaveLength(90);
    expect(new Set(corpus.seededIssues.map((issue) => issue.issueId)).size).toBe(corpus.seededIssues.length);
    expect(new Set(corpus.negativeControls.map((control) => control.assertionId)).size).toBe(corpus.negativeControls.length);
    expect(corpus.cases.every((item) => item.baseSyntheticPublicId.startsWith('synthetic-'))).toBe(true);
    expect(JSON.stringify(corpus)).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
  });

  it('declares all supported profile names and final expectations', () => {
    const corpus = buildReleaseEvaluationCorpus();
    expect(new Set(corpus.cases.map((item) => item.packageProfile))).toEqual(new Set(RELEASE_PACKAGE_PROFILES));
    expect(new Set(corpus.cases.filter((item) => item.lifecycleProfile).map((item) => item.lifecycleProfile))).toEqual(new Set(RELEASE_LIFECYCLE_PROFILES));
    expect(corpus.cases.every((item) => item.expected.finalPersistence.outcome !== 'not_run' || item.expected.persistence === 'rejected')).toBe(true);
    expect(corpus.cases.every((item) => item.seededIssueIds.every((issueId) => corpus.seededIssues.some((issue) => issue.issueId === issueId)))).toBe(true);
  });

  it('materializes accepted and rejected packages using real browser previews', async () => {
    const corpus = await materializeReleaseEvaluationCorpus({ seed: DEFAULT_SYNTHETIC_SEED, runNamespace: 'test' });
    expect(corpus.acceptedBatches.every((batch) => batch.materialized.packages.length <= 24)).toBe(true);
    expect(corpus.acceptedBatches).toHaveLength(5);
    expect(corpus.rejectedBatches).toHaveLength(2);

    const acceptedPreview = await parseBrowserImportPreview(
      corpus.acceptedBatches[0].materialized.selectionManifest,
      corpus.acceptedBatches[0].materialized.uploadedMetadataFiles,
      corpus.acceptedBatches[0].adminReferenceOptions,
    );
    expect(acceptedPreview.batch.invalidPackageCount).toBe(0);
    expect(acceptedPreview.batch.packageCount).toBe(24);

    const observed = new Map<string, { status: string; codes: string[] }>();
    for (const batch of corpus.rejectedBatches) {
      const preview = await parseBrowserImportPreview(
        batch.materialized.selectionManifest,
        batch.materialized.uploadedMetadataFiles,
        batch.adminReferenceOptions,
      );
      preview.batch.packages.forEach((pkg) => {
        const caseId = batch.caseIds.find((id) => corpus.packages.get(id)?.packagePath === pkg.packagePath);
        if (caseId) observed.set(caseId, { status: pkg.status, codes: [...pkg.errors, ...pkg.warnings].map((issue) => issue.code) });
      });
    }
    expect(observed.get('release-case-121')).toEqual(expect.objectContaining({ status: 'invalid' }));
    expect(observed.get('release-case-121')?.codes).toContain('WORKBOOK_MISSING_REQUIRED_VALUE');
    expect(observed.get('release-case-124')?.codes).toContain('ADMIN_REFERENCE_NO_MATCH');
    expect(observed.get('release-case-128')?.codes).toContain('METADATA_MISSING_GALLERY_ALT_TEXT');
    expect(observed.get('release-case-131')?.codes).toContain('WORKBOOK_MALFORMED');
    expect(observed.get('release-case-132')?.status).toBe('valid');
  });
});
