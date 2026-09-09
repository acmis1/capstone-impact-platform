export const ANNUAL_PUBLICATION_TARGET = 120;

export interface AnnualPublicationEvidenceSnapshot {
  intendedPublicIds: readonly string[];
  finalFeedPublicIds: readonly string[];
  finalFeedRecordCount: number;
  publicationOperations: number;
  completedPublications: number;
  publicationVersions: number;
  publicationVersionMembers: number;
  publicationAuditRecords: number;
  publishedProjects: number;
  activePublicationOperations: number;
  feedValid: boolean;
  headMatchesStorage: boolean;
  idempotencyChangedEvidence: boolean;
  privateFeedReferences: number;
  negativeControlCreatedDeploymentState: boolean;
}

export function expectedPublicationVersionMemberCount(
  targetProjects = ANNUAL_PUBLICATION_TARGET,
): number {
  if (!Number.isSafeInteger(targetProjects) || targetProjects < 0) {
    throw new Error('ANNUAL_PUBLICATION_TARGET_INVALID');
  }
  return (targetProjects * (targetProjects + 1)) / 2;
}

/**
 * Fail-closed final accounting for the annual publication verifier.
 *
 * The version-member total is triangular because every immutable publication version stores the
 * complete feed membership at that point: 1 + 2 + ... + 120. This is intentionally derived from
 * the ledger semantics instead of treating the final head membership as the historical total.
 */
export function assertAnnualPublicationEvidence(
  snapshot: AnnualPublicationEvidenceSnapshot,
): void {
  const intended = new Set(snapshot.intendedPublicIds);
  const finalMembers = new Set(snapshot.finalFeedPublicIds);
  const target = ANNUAL_PUBLICATION_TARGET;

  if (snapshot.intendedPublicIds.length !== target || intended.size !== target) {
    throw new Error('ANNUAL_COHORT_IDENTITY_INVALID');
  }
  if (snapshot.finalFeedRecordCount !== target || snapshot.finalFeedPublicIds.length !== target) {
    throw new Error('ANNUAL_FINAL_FEED_COUNT_INVALID');
  }
  if (finalMembers.size !== target) throw new Error('ANNUAL_FINAL_FEED_DUPLICATE_PUBLIC_ID');
  if ([...intended].some((publicId) => !finalMembers.has(publicId))) {
    throw new Error('ANNUAL_FINAL_FEED_COHORT_MEMBER_MISSING');
  }
  if ([...finalMembers].some((publicId) => !intended.has(publicId))) {
    throw new Error('ANNUAL_FINAL_FEED_UNEXPECTED_MEMBER');
  }
  if (snapshot.publicationOperations !== target) throw new Error('ANNUAL_PUBLICATION_OPERATIONS_INVALID');
  if (snapshot.completedPublications !== target) throw new Error('ANNUAL_COMPLETED_PUBLICATIONS_INVALID');
  if (snapshot.publicationVersions !== target) throw new Error('ANNUAL_PUBLICATION_VERSIONS_INVALID');
  if (snapshot.publicationVersionMembers !== expectedPublicationVersionMemberCount(target)) {
    throw new Error('ANNUAL_PUBLICATION_VERSION_MEMBERS_INVALID');
  }
  if (snapshot.publicationAuditRecords !== target) throw new Error('ANNUAL_PUBLICATION_AUDIT_INVALID');
  if (snapshot.publishedProjects !== target) throw new Error('ANNUAL_PUBLISHED_PROJECTS_INVALID');
  if (snapshot.activePublicationOperations !== 0) throw new Error('ANNUAL_ACTIVE_OPERATION_REMAINS');
  if (!snapshot.feedValid) throw new Error('ANNUAL_FEED_INVALID');
  if (!snapshot.headMatchesStorage) throw new Error('ANNUAL_HEAD_STORAGE_MISMATCH');
  if (snapshot.idempotencyChangedEvidence) throw new Error('ANNUAL_IDEMPOTENCY_CHANGED_EVIDENCE');
  if (snapshot.privateFeedReferences !== 0) throw new Error('ANNUAL_PRIVATE_FEED_REFERENCE');
  if (snapshot.negativeControlCreatedDeploymentState) throw new Error('ANNUAL_NEGATIVE_CONTROL_DEPLOYED');
}
