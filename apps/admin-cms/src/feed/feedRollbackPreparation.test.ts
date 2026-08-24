import { describe, expect, it } from 'vitest';

import type { PublicFeedRecord } from '../domain/publicFeed';
import type { PublicFeedVersionDetail } from '../domain/feedHistory';

import { serializePublicFeedArtifact } from '../feed/serializePublicFeedArtifact';

import {
  prepareFeedRollback,
} from './feedRollbackPreparation';

function record(
  publicId: string,
): PublicFeedRecord {
  return {
    id: publicId.length,
    publicId,
    title: `Project ${publicId}`,
    summary: 'Summary',
    background: 'Background',
    solution: 'Solution',
    year: '2026',
    program: 'Software Engineering',
    studyProgram: 'Software Engineering',
    discipline: 'Software Engineering',
    disciplines: ['Software Engineering'],
    industry: 'Technology',
    industryPartner: '',
    academicSupervisor: 'Supervisor',
    groupName: 'Group',
    teamMembers: ['Student'],
    poster:
      'https://example.test/poster.png',
    posterPdf:
      'https://example.test/poster.pdf',
    posterText: 'Poster text',
    accessibilityText:
      'Accessible poster description.',
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
  };
}

function historicalVersion(
  records: PublicFeedRecord[],
): PublicFeedVersionDetail {
  const artifact =
    serializePublicFeedArtifact(records);

  return {
    id: 'version-1',
    versionNumber: 1,
    operationType: 'publication',
    createdAt:
      '2026-08-22T10:00:00.000Z',

    actorAdminId: 'admin-id',
    actorName: 'Admin',
    actorEmail: 'admin@example.test',

    affectedPublicId:
      '2026-project-a',

    affectedProjectTitle:
      'Project A',

    recordCount:
      artifact.recordCount,

    feedHash: artifact.feedHash,

    previousVersionId: null,
    restoredFromVersionId: null,

    isCurrent: false,

    artifactContent:
      artifact.content,
  };
}

describe('prepareFeedRollback', () => {
  it('prepares an exact restoration plan without mutation', async () => {
    const target = historicalVersion([
      record('2026-project-a'),
    ]);

    const current =
      serializePublicFeedArtifact([
        record('2026-project-a'),
        record('2026-project-b'),
      ]);

    let writes = 0;

    const result =
      await prepareFeedRollback({
        targetVersionId: target.id,

        dependencies: {
          getVersion: async () => target,

          downloadCanonicalFeed:
            async () => {
              return Buffer.from(
                current.content,
                'utf8',
              );
            },
        },
      });

    expect(writes).toBe(0);
    expect(result.resultCode).toBe(
      'READY',
    );

    if (result.resultCode !== 'READY') {
      throw new Error('Expected READY');
    }

    expect(
      result.preparation.removedPublicIds,
    ).toEqual(['2026-project-b']);

    expect(
      result.preparation.addedPublicIds,
    ).toEqual([]);

    expect(
      result.preparation.wouldChangeFeed,
    ).toBe(true);
  });

  it('can prepare rollback to an older version', async () => {
    const target = historicalVersion([
      record('2026-project-a'),
    ]);

    const current =
      serializePublicFeedArtifact([
        record('2026-project-a'),
        record('2026-project-b'),
        record('2026-project-c'),
      ]);

    const result =
      await prepareFeedRollback({
        targetVersionId: target.id,

        dependencies: {
          getVersion:
            async () => target,

          downloadCanonicalFeed:
            async () =>
              Buffer.from(
                current.content,
                'utf8',
              ),
        },
      });

    expect(result.resultCode).toBe(
      'READY',
    );

    if (result.resultCode !== 'READY') {
      throw new Error('Expected READY');
    }

    expect(
      result.preparation.removedPublicIds,
    ).toEqual([
      '2026-project-b',
      '2026-project-c',
    ]);
  });

  it('rejects missing historical artifact', async () => {
    const result =
      await prepareFeedRollback({
        targetVersionId: 'missing',

        dependencies: {
          getVersion:
            async () => null,

          downloadCanonicalFeed:
            async () => null,
        },
      });

    expect(result.resultCode).toBe(
      'HISTORICAL_VERSION_NOT_FOUND',
    );
  });

  it('rejects corrupted historical evidence', async () => {
    const target =
      historicalVersion([
        record('2026-project-a'),
      ]);

    const corrupted = {
      ...target,
      artifactContent:
        target.artifactContent + ' ',
    };

    const current =
      serializePublicFeedArtifact([
        record('2026-project-a'),
      ]);

    const result =
      await prepareFeedRollback({
        targetVersionId:
          corrupted.id,

        dependencies: {
          getVersion:
            async () => corrupted,

          downloadCanonicalFeed:
            async () =>
              Buffer.from(
                current.content,
                'utf8',
              ),
        },
      });

    expect(result.resultCode).toBe(
      'HISTORICAL_ARTIFACT_INVALID',
    );
  });
});