'use server';

import { revalidatePath } from 'next/cache';

import { requireAdmin } from '../../../../auth/requireAdmin';
import { canPreparePublication } from '../../../../auth/permissions';

import {
  executeLocalFeedRollback,
  ROLLBACK_ACKNOWLEDGEMENT,
} from '../../../../projects/localFeedRollbackExecution';

import {
  createLocalFeedRollbackDependencies,
} from '../../../../projects/createLocalFeedRollbackDependencies';

export interface ExecuteFeedRollbackActionState {
  status:
    | 'idle'
    | 'success'
    | 'error';

  message?: string;

  resultCode?: string;

  historyVersionId?: string;
}

export async function executeFeedRollbackAction(
  _previousState: ExecuteFeedRollbackActionState,
  formData: FormData,
): Promise<ExecuteFeedRollbackActionState> {
  try {
    const adminContext = await requireAdmin();

    if (
      !canPreparePublication(
        adminContext.permissions,
      )
    ) {
      return {
        status: 'error',
        resultCode: 'PERMISSION_DENIED',
        message:
          'Administrator publication authority is required to execute rollback.',
      };
    }

    const targetVersionId =
      String(
        formData.get(
          'targetVersionId',
        ) ?? '',
      ).trim();

    const preparedBaselineFeedHash =
      String(
        formData.get(
          'preparedBaselineFeedHash',
        ) ?? '',
      ).trim();

    const acknowledgement =
      String(
        formData.get(
          'acknowledgement',
        ) ?? '',
      );

    const operationKey =
      String(
        formData.get(
          'operationKey',
        ) ?? '',
      ).trim();

    const versionNumber =
      Number(
        formData.get(
          'versionNumber',
        ),
      );

    if (
      !targetVersionId ||
      !/^[0-9a-f-]{36}$/i.test(
        targetVersionId,
      ) ||
      !/^[0-9a-f]{64}$/.test(
        preparedBaselineFeedHash,
      ) ||
      acknowledgement !==
        ROLLBACK_ACKNOWLEDGEMENT ||
      !operationKey ||
      !/^[0-9a-f-]{36}$/i.test(
        operationKey,
      ) ||
      !Number.isSafeInteger(
        versionNumber,
      ) ||
      versionNumber <= 0
    ) {
      return {
        status: 'error',
        resultCode: 'INVALID_INPUT',
        message:
          'Rollback execution input is invalid or incomplete.',
      };
    }

    const result =
      await executeLocalFeedRollback({
        targetVersionId,

        actorAdminId:
          adminContext.adminUserId,

        acknowledgement,

        preparedBaselineFeedHash,

        operationKey,

        dependencies:
          createLocalFeedRollbackDependencies(),
      });

    if (
      result.resultCode ===
        'COMPLETED' ||
      result.resultCode ===
        'ALREADY_COMPLETED'
    ) {
      revalidatePath(
        '/admin/feed-history',
      );

      revalidatePath(
        `/admin/feed-history/${versionNumber}`,
      );

      return {
        status: 'success',

        resultCode:
          result.resultCode,

        message:
          result.resultCode ===
          'ALREADY_COMPLETED'
            ? 'This rollback operation had already completed successfully.'
            : 'Local public-feed rollback completed successfully.',

        historyVersionId:
          result.historyVersionId,
      };
    }

    switch (result.resultCode) {
      case 'ACKNOWLEDGEMENT_REQUIRED':
        return {
          status: 'error',
          resultCode:
            result.resultCode,
          message:
            'Explicit rollback acknowledgement is required.',
        };

      case 'LOCAL_EXECUTION_REQUIRED':
        return {
          status: 'error',
          resultCode:
            result.resultCode,
          message:
            'Rollback execution is disabled outside a proven Local/disposable environment.',
        };

      case 'STALE_PREPARATION':
        return {
          status: 'error',
          resultCode:
            result.resultCode,
          message:
            'The canonical feed changed after preparation. Prepare the rollback again before executing.',
        };

      case 'PUBLICATION_IN_PROGRESS':
        return {
          status: 'error',
          resultCode:
            result.resultCode,
          message:
            'Another publication or public-feed operation is currently in progress.',
        };

      case 'ROLLBACK_IN_PROGRESS':
        return {
          status: 'error',
          resultCode:
            result.resultCode,
          message:
            'Another rollback operation is currently in progress.',
        };

      case 'COMPENSATION_INCOMPLETE':
        return {
          status: 'error',
          resultCode:
            result.resultCode,
          message:
            'Rollback recovery could not safely restore the canonical baseline. Manual investigation is required.',
        };

      case 'HISTORICAL_ARTIFACT_INVALID':
        return {
          status: 'error',
          resultCode:
            result.resultCode,
          message:
            'The selected historical feed failed integrity verification.',
        };

      case 'HISTORICAL_VERSION_NOT_FOUND':
        return {
          status: 'error',
          resultCode:
            result.resultCode,
          message:
            'The selected historical feed version no longer exists.',
        };

      case 'CURRENT_FEED_MISSING':
      case 'CURRENT_FEED_INVALID':
        return {
          status: 'error',
          resultCode:
            result.resultCode,
          message:
            'The current canonical feed could not be verified safely.',
        };

      case 'PERMISSION_DENIED':
        return {
          status: 'error',
          resultCode:
            result.resultCode,
          message:
            'Administrator publication authority is required to execute rollback.',
        };

      default:
        return {
          status: 'error',
          resultCode:
            result.resultCode,
          message:
            'Rollback execution failed safely. The canonical feed was not silently accepted as successful.',
        };
    }
  } catch (error: unknown) {
    console.error(
      '[Feed rollback execution action failure]',
      error instanceof Error
        ? error.name
        : 'UNKNOWN_FAILURE',
    );

    return {
      status: 'error',
      resultCode:
        'EXECUTION_FAILED',
      message:
        'Rollback execution could not be completed safely.',
    };
  }
}