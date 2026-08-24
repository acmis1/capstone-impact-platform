import { describe, expect, it } from 'vitest';

import type {
  FeedRollbackRpcResult,
  PublicFeedVersionDetail,
} from '../domain/feedHistory';

import type { PublicFeedRecord } from '../domain/publicFeed';

import {
  serializePublicFeedArtifact,
} from '../feed/serializePublicFeedArtifact';

import {
  executeLocalFeedRollback,
  ROLLBACK_ACKNOWLEDGEMENT,
  type RollbackExecutionRecorder,
} from './localFeedRollbackExecution';

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

function version(
  records: PublicFeedRecord[],
): PublicFeedVersionDetail {
  const artifact =
    serializePublicFeedArtifact(records);

  return {
    id: 'historical-version',
    versionNumber: 3,
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

    feedHash:
      artifact.feedHash,

    previousVersionId: null,
    restoredFromVersionId: null,

    isCurrent: false,

    artifactContent:
      artifact.content,
  };
}

class FakeRecorder
  implements RollbackExecutionRecorder {
  reserveResult: FeedRollbackRpcResult = {
    resultCode: 'ATTEMPT_RESERVED',
    attemptId: 'attempt-id',
    executionToken: 'token-id',
  };

  prepareResult: FeedRollbackRpcResult = {
    resultCode: 'ARTIFACT_BOUND',
  };

  markResult: FeedRollbackRpcResult = {
    resultCode: 'STORAGE_WRITTEN',
  };

  finalizeResult: FeedRollbackRpcResult = {
    resultCode: 'COMPLETED',
    historyVersionId: 'new-history-version',
  };

  failures: Array<{
    failureCode: string;
    compensationFailureCode?: string;
  }> = [];

  async reserve(): Promise<FeedRollbackRpcResult> {
    return this.reserveResult;
  }

  async prepare(): Promise<FeedRollbackRpcResult> {
    return this.prepareResult;
  }

  async markStorageWritten():
    Promise<FeedRollbackRpcResult> {
    return this.markResult;
  }

  async finalize():
    Promise<FeedRollbackRpcResult> {
    return this.finalizeResult;
  }

  async fail(params: {
    attemptId: string;
    executionToken: string;
    failureCode: string;
    compensationFailureCode?: string;
  }): Promise<FeedRollbackRpcResult> {
    this.failures.push({
      failureCode:
        params.failureCode,

      compensationFailureCode:
        params.compensationFailureCode,
    });

    return {
      resultCode:
        params.compensationFailureCode
          ? 'COMPENSATION_INCOMPLETE'
          : 'FAILED',
    };
  }
}

function storage(initialContent: string) {
  let content = initialContent;

  return {
    get content() {
      return content;
    },

    async download() {
      return Buffer.from(
        content,
        'utf8',
      );
    },

    async uploadExact(next: string) {
      content = next;
    },
  };
}

describe('executeLocalFeedRollback', () => {
  it('completes a verified Local rollback', async () => {
    const target = version([
      record('2026-project-a'),
    ]);

    const current =
      serializePublicFeedArtifact([
        record('2026-project-a'),
        record('2026-project-b'),
      ]);

    const fakeStorage =
      storage(current.content);

    const recorder =
      new FakeRecorder();

    const result =
      await executeLocalFeedRollback({
        targetVersionId:
          target.id,

        actorAdminId:
          'admin-id',

        acknowledgement:
          ROLLBACK_ACKNOWLEDGEMENT,

        preparedBaselineFeedHash:
          current.feedHash,

        operationKey:
          '00000000-0000-4000-8000-000000000001',

        dependencies: {
          getVersion:
            async () => target,

          recorder,

          storage:
            fakeStorage,

          isLocalExecutionAvailable:
            () => true,
        },
      });

    expect(result).toEqual({
      resultCode: 'COMPLETED',
      attemptId: 'attempt-id',
      historyVersionId:
        'new-history-version',
    });

    expect(fakeStorage.content).toBe(
      target.artifactContent,
    );

    expect(recorder.failures).toEqual(
      [],
    );
  });

  it('requires explicit acknowledgement', async () => {
    const target = version([]);

    const current =
      serializePublicFeedArtifact([]);

    const result =
      await executeLocalFeedRollback({
        targetVersionId:
          target.id,

        actorAdminId:
          'admin-id',

        acknowledgement:
          'yes',

        preparedBaselineFeedHash:
          current.feedHash,

        dependencies: {
          getVersion:
            async () => target,

          recorder:
            new FakeRecorder(),

          storage:
            storage(current.content),

          isLocalExecutionAvailable:
            () => true,
        },
      });

    expect(result.resultCode).toBe(
      'ACKNOWLEDGEMENT_REQUIRED',
    );
  });

  it('rejects hosted execution', async () => {
    const target = version([]);

    const current =
      serializePublicFeedArtifact([]);

    const result =
      await executeLocalFeedRollback({
        targetVersionId:
          target.id,

        actorAdminId:
          'admin-id',

        acknowledgement:
          ROLLBACK_ACKNOWLEDGEMENT,

        preparedBaselineFeedHash:
          current.feedHash,

        dependencies: {
          getVersion:
            async () => target,

          recorder:
            new FakeRecorder(),

          storage:
            storage(current.content),

          isLocalExecutionAvailable:
            () => false,
        },
      });

    expect(result.resultCode).toBe(
      'LOCAL_EXECUTION_REQUIRED',
    );
  });

  it('rejects stale preparation before reservation', async () => {
    const target = version([
      record('2026-project-a'),
    ]);

    const current =
      serializePublicFeedArtifact([
        record('2026-project-a'),
        record('2026-project-b'),
      ]);

    const result =
      await executeLocalFeedRollback({
        targetVersionId:
          target.id,

        actorAdminId:
          'admin-id',

        acknowledgement:
          ROLLBACK_ACKNOWLEDGEMENT,

        preparedBaselineFeedHash:
          '0'.repeat(64),

        dependencies: {
          getVersion:
            async () => target,

          recorder:
            new FakeRecorder(),

          storage:
            storage(current.content),

          isLocalExecutionAvailable:
            () => true,
        },
      });

    expect(result.resultCode).toBe(
      'STALE_PREPARATION',
    );
  });

  it('returns already completed for duplicate execution', async () => {
    const target = version([
      record('2026-project-a'),
    ]);

    const current =
      serializePublicFeedArtifact([
        record('2026-project-b'),
      ]);

    const recorder =
      new FakeRecorder();

    recorder.reserveResult = {
      resultCode:
        'ALREADY_COMPLETED',

      attemptId:
        'attempt-id',

      historyVersionId:
        'existing-version',
    };

    const result =
      await executeLocalFeedRollback({
        targetVersionId:
          target.id,

        actorAdminId:
          'admin-id',

        acknowledgement:
          ROLLBACK_ACKNOWLEDGEMENT,

        preparedBaselineFeedHash:
          current.feedHash,

        operationKey:
          '00000000-0000-4000-8000-000000000001',

        dependencies: {
          getVersion:
            async () => target,

          recorder,

          storage:
            storage(current.content),

          isLocalExecutionAvailable:
            () => true,
        },
      });

    expect(result).toEqual({
      resultCode:
        'ALREADY_COMPLETED',

      attemptId:
        'attempt-id',

      historyVersionId:
        'existing-version',
    });
  });

  it('compensates if finalization fails after canonical write', async () => {
    const target = version([
      record('2026-project-a'),
    ]);

    const current =
      serializePublicFeedArtifact([
        record('2026-project-b'),
      ]);

    const fakeStorage =
      storage(current.content);

    const recorder =
      new FakeRecorder();

    recorder.finalizeResult = {
      resultCode:
        'INVALID_ATTEMPT_STATE',
    };

    const result =
      await executeLocalFeedRollback({
        targetVersionId:
          target.id,

        actorAdminId:
          'admin-id',

        acknowledgement:
          ROLLBACK_ACKNOWLEDGEMENT,

        preparedBaselineFeedHash:
          current.feedHash,

        operationKey:
          '00000000-0000-4000-8000-000000000001',

        dependencies: {
          getVersion:
            async () => target,

          recorder,

          storage:
            fakeStorage,

          isLocalExecutionAvailable:
            () => true,
        },
      });

    expect(result.resultCode).toBe(
      'EXECUTION_FAILED',
    );

    // Exact original baseline restored.
    expect(fakeStorage.content).toBe(
      current.content,
    );

    expect(recorder.failures).toHaveLength(
      1,
    );
  });

  it('records compensation-incomplete when baseline cannot be restored', async () => {
    const target = version([
      record('2026-project-a'),
    ]);

    const current =
      serializePublicFeedArtifact([
        record('2026-project-b'),
      ]);

    let content = current.content;
    let writes = 0;

    const recorder =
      new FakeRecorder();

    recorder.finalizeResult = {
      resultCode:
        'INVALID_ATTEMPT_STATE',
    };

    const result =
      await executeLocalFeedRollback({
        targetVersionId:
          target.id,

        actorAdminId:
          'admin-id',

        acknowledgement:
          ROLLBACK_ACKNOWLEDGEMENT,

        preparedBaselineFeedHash:
          current.feedHash,

        operationKey:
          '00000000-0000-4000-8000-000000000001',

        dependencies: {
          getVersion:
            async () => target,

          recorder,

          storage: {
            async download() {
              return Buffer.from(
                content,
                'utf8',
              );
            },

            async uploadExact(
              next: string,
            ) {
              writes += 1;

              if (writes === 1) {
                content = next;
                return;
              }

              throw new Error(
                'restore failed',
              );
            },
          },

          isLocalExecutionAvailable:
            () => true,
        },
      });

    expect(result.resultCode).toBe(
      'COMPENSATION_INCOMPLETE',
    );

    expect(
      recorder.failures[0]
        ?.compensationFailureCode,
    ).toBe(
      'CANONICAL_FEED_COMPENSATION_FAILED',
    );
  });

  it('supports rollback to a zero-record historical feed', async () => {
    const target = version([]);

    const current =
      serializePublicFeedArtifact([
        record('2026-project-a'),
      ]);

    const fakeStorage =
      storage(current.content);

    const result =
      await executeLocalFeedRollback({
        targetVersionId:
          target.id,

        actorAdminId:
          'admin-id',

        acknowledgement:
          ROLLBACK_ACKNOWLEDGEMENT,

        preparedBaselineFeedHash:
          current.feedHash,

        operationKey:
          '00000000-0000-4000-8000-000000000001',

        dependencies: {
          getVersion:
            async () => target,

          recorder:
            new FakeRecorder(),

          storage:
            fakeStorage,

          isLocalExecutionAvailable:
            () => true,
        },
      });

    expect(result.resultCode).toBe(
      'COMPLETED',
    );

    expect(
      JSON.parse(fakeStorage.content),
    ).toEqual([]);
  });
});