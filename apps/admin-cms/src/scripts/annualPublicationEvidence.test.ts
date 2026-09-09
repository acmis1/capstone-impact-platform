import { describe, expect, it } from 'vitest';
import {
  ANNUAL_PUBLICATION_TARGET,
  assertAnnualPublicationEvidence,
  expectedPublicationVersionMemberCount,
  type AnnualPublicationEvidenceSnapshot,
} from './annualPublicationEvidence';

function validSnapshot(): AnnualPublicationEvidenceSnapshot {
  const ids = Array.from(
    { length: ANNUAL_PUBLICATION_TARGET },
    (_, index) => `annual-${String(index + 1).padStart(3, '0')}`,
  );
  return {
    intendedPublicIds: ids,
    finalFeedPublicIds: [...ids],
    finalFeedRecordCount: ANNUAL_PUBLICATION_TARGET,
    publicationOperations: ANNUAL_PUBLICATION_TARGET,
    completedPublications: ANNUAL_PUBLICATION_TARGET,
    publicationVersions: ANNUAL_PUBLICATION_TARGET,
    publicationVersionMembers: expectedPublicationVersionMemberCount(),
    publicationAuditRecords: ANNUAL_PUBLICATION_TARGET,
    publishedProjects: ANNUAL_PUBLICATION_TARGET,
    activePublicationOperations: 0,
    feedValid: true,
    headMatchesStorage: true,
    idempotencyChangedEvidence: false,
    privateFeedReferences: 0,
    negativeControlCreatedDeploymentState: false,
  };
}

describe('annual publication evidence accounting', () => {
  it('derives the immutable publication version-member total', () => {
    expect(expectedPublicationVersionMemberCount()).toBe(7_260);
  });

  it('accepts exact 120-project governed publication accounting', () => {
    expect(() => assertAnnualPublicationEvidence(validSnapshot())).not.toThrow();
  });

  it.each([
    ['a missing cohort ID', (snapshot: AnnualPublicationEvidenceSnapshot) => ({
      ...snapshot, intendedPublicIds: snapshot.intendedPublicIds.slice(0, -1),
    })],
    ['a duplicate cohort ID', (snapshot: AnnualPublicationEvidenceSnapshot) => ({
      ...snapshot, intendedPublicIds: [...snapshot.intendedPublicIds.slice(0, -1), snapshot.intendedPublicIds[0]],
    })],
    ['an unexpected final-feed member', (snapshot: AnnualPublicationEvidenceSnapshot) => ({
      ...snapshot, finalFeedPublicIds: [...snapshot.finalFeedPublicIds.slice(0, -1), 'unexpected'],
    })],
    ['an incomplete final-feed count', (snapshot: AnnualPublicationEvidenceSnapshot) => ({
      ...snapshot, finalFeedRecordCount: 119,
    })],
    ['an unpublished cohort project', (snapshot: AnnualPublicationEvidenceSnapshot) => ({
      ...snapshot, publishedProjects: 119,
    })],
    ['an active operation', (snapshot: AnnualPublicationEvidenceSnapshot) => ({
      ...snapshot, activePublicationOperations: 1,
    })],
    ['changed idempotency evidence', (snapshot: AnnualPublicationEvidenceSnapshot) => ({
      ...snapshot, idempotencyChangedEvidence: true,
    })],
    ['a private feed reference', (snapshot: AnnualPublicationEvidenceSnapshot) => ({
      ...snapshot, privateFeedReferences: 1,
    })],
    ['a negative-control deployment', (snapshot: AnnualPublicationEvidenceSnapshot) => ({
      ...snapshot, negativeControlCreatedDeploymentState: true,
    })],
  ])('fails closed for %s', (_label, mutate) => {
    expect(() => assertAnnualPublicationEvidence(mutate(validSnapshot()))).toThrow();
  });
});
