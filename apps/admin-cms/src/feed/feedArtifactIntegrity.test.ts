import { describe, expect, it } from 'vitest';

import type { PublicFeedRecord } from '../domain/publicFeed';
import { serializePublicFeedArtifact } from './serializePublicFeedArtifact';
import {
  FeedArtifactVerificationError,
  verifyHistoricalFeedArtifact,
} from './feedArtifactIntegrity';

function record(
  overrides: Partial<PublicFeedRecord> = {},
): PublicFeedRecord {
  return {
    id: 1,
    publicId: '2026-example',
    title: 'Example Project',
    summary: 'Summary',
    background: 'Background',
    solution: 'Solution',
    year: '2026',
    program: 'Software Engineering',
    studyProgram: 'Software Engineering',
    discipline: 'Software Engineering',
    disciplines: ['Software Engineering'],
    industry: 'Technology',
    industryPartner: 'Example Partner',
    academicSupervisor: 'Example Supervisor',
    groupName: 'Example Group',
    teamMembers: ['Student One'],
    poster: 'https://example.test/poster.png',
    posterPdf: 'https://example.test/poster.pdf',
    posterText: 'Poster text',
    accessibilityText:
      'Accessible description of project poster.',
    snapshots: [],
    snapshotMedia: [],
    layoutConfig: {
      templateId: 'poster_showcase',
      featuredMedia: 'poster',
      sectionOrder: [
        'background',
        'solution',
        'snapshots',
        'video',
        'links',
      ],
    },
    ...overrides,
  };
}

describe('verifyHistoricalFeedArtifact', () => {
  it('accepts an exact canonical feed artifact', () => {
    const artifact = serializePublicFeedArtifact([
      record(),
    ]);

    const verified =
      verifyHistoricalFeedArtifact({
        content: artifact.content,
        expectedHash: artifact.feedHash,
        expectedRecordCount:
          artifact.recordCount,
      });

    expect(verified.feedHash).toBe(
      artifact.feedHash,
    );
    expect(verified.recordCount).toBe(1);
  });

  it('supports a zero-record feed', () => {
    const artifact =
      serializePublicFeedArtifact([]);

    const verified =
      verifyHistoricalFeedArtifact({
        content: artifact.content,
        expectedHash: artifact.feedHash,
        expectedRecordCount: 0,
      });

    expect(verified.recordCount).toBe(0);
    expect(verified.records).toEqual([]);
  });

  it('rejects checksum mismatch', () => {
    const artifact = serializePublicFeedArtifact([
      record(),
    ]);

    expect(() =>
      verifyHistoricalFeedArtifact({
        content: artifact.content,
        expectedHash: '0'.repeat(64),
        expectedRecordCount: 1,
      }),
    ).toThrowError(
      new FeedArtifactVerificationError(
        'ARTIFACT_HASH_MISMATCH',
      ),
    );
  });

  it('rejects malformed JSON', () => {
    expect(() =>
      verifyHistoricalFeedArtifact({
        content: '{broken',
        expectedHash: '0'.repeat(64),
        expectedRecordCount: 1,
      }),
    ).toThrow();
  });

  it('rejects a mismatched record count', () => {
    const artifact = serializePublicFeedArtifact([
      record(),
    ]);

    expect(() =>
      verifyHistoricalFeedArtifact({
        content: artifact.content,
        expectedHash: artifact.feedHash,
        expectedRecordCount: 2,
      }),
    ).toThrowError(
      new FeedArtifactVerificationError(
        'ARTIFACT_RECORD_COUNT_MISMATCH',
      ),
    );
  });
});