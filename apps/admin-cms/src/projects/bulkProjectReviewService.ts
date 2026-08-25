import { hasPermission } from '../auth/permissions';
import {
  BULK_REVIEW_MAX_COMMENT_LENGTH,
  BULK_REVIEW_MAX_SELECTION,
  BulkReviewAction,
  BulkReviewActor,
  BulkReviewExecutionResponse,
  BulkReviewOutcome,
  BulkReviewPreflightResponse,
  BulkReviewProjectState,
  classifyBulkReviewState,
  normalizeBulkReasons,
  requiredPermissionForBulkAction,
  sortBulkReviewItems,
  summarizeBulkPreflight,
  toSafeExecutionItem,
} from './bulkProjectReview';

export type BulkGatewayResultCode = 'SUCCESS' | 'ALREADY_COMPLETE' | 'STALE_VERSION' | 'BLOCKED' | 'FAILED';

export interface BulkGatewayExecutionResult {
  resultCode: BulkGatewayResultCode;
  status: BulkReviewProjectState['status'];
  reason?: { code: string; message: string };
  auditRecorded: boolean;
}

export interface BulkProjectReviewGateway {
  loadProjectStates(publicIds: string[]): Promise<Map<string, BulkReviewProjectState>>;
  executeAction(params: {
    action: BulkReviewAction;
    publicId: string;
    expectedUpdatedAt: string;
    comments?: string;
    adminId: string;
  }): Promise<BulkGatewayExecutionResult>;
}

export class BulkReviewPermissionError extends Error {
  constructor() {
    super('Bulk project review permission denied.');
    this.name = 'BulkReviewPermissionError';
  }
}

export class BulkReviewService {
  constructor(private readonly gateway: BulkProjectReviewGateway) {}

  private authorize(action: BulkReviewAction, actor: BulkReviewActor): void {
    if (!hasPermission(actor.permissions, requiredPermissionForBulkAction(action))) {
      throw new BulkReviewPermissionError();
    }
  }

  private missingState(publicId: string): BulkReviewProjectState {
    return {
      publicId,
      title: 'Project unavailable',
      status: null,
      updatedAt: null,
      exists: false,
      submission: null,
      review: null,
    };
  }

  async preflight(params: {
    action: BulkReviewAction;
    publicIds: string[];
    actor: BulkReviewActor;
  }): Promise<BulkReviewPreflightResponse> {
    this.authorize(params.action, params.actor);
    if (params.publicIds.length < 1 || params.publicIds.length > BULK_REVIEW_MAX_SELECTION) {
      throw new Error('Bulk project review selection is out of bounds.');
    }

    const states = await this.gateway.loadProjectStates(params.publicIds);
    const items = sortBulkReviewItems(params.publicIds.map((publicId) => {
      const state = states.get(publicId) || this.missingState(publicId);
      return classifyBulkReviewState(params.action, state);
    }));

    return { action: params.action, summary: summarizeBulkPreflight(items), items };
  }

  async execute(params: {
    action: BulkReviewAction;
    publicIds: string[];
    expectedUpdatedAt: Record<string, string | null>;
    comments?: string;
    actor: BulkReviewActor;
  }): Promise<BulkReviewExecutionResponse> {
    this.authorize(params.action, params.actor);
    if (params.publicIds.length < 1 || params.publicIds.length > BULK_REVIEW_MAX_SELECTION) {
      throw new Error('Bulk project review selection is out of bounds.');
    }
    const normalizedComments = params.comments?.trim();
    if (normalizedComments && normalizedComments.length > BULK_REVIEW_MAX_COMMENT_LENGTH) {
      throw new Error('Bulk review comments are out of bounds.');
    }
    if (params.action !== 'request_changes' && normalizedComments !== undefined) {
      throw new Error('Bulk review comments are not allowed for this action.');
    }
    if (params.action === 'request_changes' && !normalizedComments) {
      throw new Error('Bulk request-changes comments are required.');
    }

    // One bounded, set-based execution-time revalidation protects the whole request. Each
    // subsequent RPC also applies the database row/version fence, avoiding an O(n^2) full scan.
    const states = await this.gateway.loadProjectStates(params.publicIds);
    const executionItems: ReturnType<typeof toSafeExecutionItem>[] = [];

    for (const publicId of [...params.publicIds].sort((a, b) => a.localeCompare(b))) {
      const state = states.get(publicId) || this.missingState(publicId);
      const expected = params.expectedUpdatedAt[publicId];
      const preflightItem = classifyBulkReviewState(params.action, state, expected);

      if (preflightItem.disposition !== 'eligible') {
        const outcome: BulkReviewOutcome = preflightItem.disposition;
        executionItems.push(toSafeExecutionItem(preflightItem, outcome, false));
        continue;
      }

      // A current version is required for an eligible execution target. The classifier normally
      // enforces this, but keep the guard explicit at the mutation boundary.
      if (!expected) {
        const reason = normalizeBulkReasons([
          { code: 'STALE_VERSION', message: 'The project version was not supplied for execution.' },
        ]);
        executionItems.push(toSafeExecutionItem({ ...preflightItem, disposition: 'invalid_or_stale', ...reason }, 'invalid_or_stale'));
        continue;
      }

      let result: BulkGatewayExecutionResult;
      try {
        result = await this.gateway.executeAction({
          action: params.action,
          publicId,
          expectedUpdatedAt: expected,
          comments: params.action === 'request_changes' ? normalizedComments : undefined,
          adminId: params.actor.adminId,
        });
      } catch {
        result = {
          resultCode: 'FAILED',
          status: state.status,
          auditRecorded: false,
          reason: { code: 'WORKFLOW_EXECUTION_FAILED', message: 'The workflow action could not be completed.' },
        };
      }

      const outcome: BulkReviewOutcome = result.resultCode === 'SUCCESS'
        ? 'successful'
        : result.resultCode === 'ALREADY_COMPLETE'
          ? 'already_complete'
          : result.resultCode === 'STALE_VERSION'
            ? 'invalid_or_stale'
            : result.resultCode === 'BLOCKED'
              ? 'blocked'
              : 'failed';
      const reasons = result.reason ? normalizeBulkReasons([result.reason]) : { reasons: [], additionalReasonCount: 0 };
      executionItems.push(toSafeExecutionItem({
        ...preflightItem,
        status: result.status,
        disposition: outcome === 'successful' ? 'eligible' : preflightItem.disposition,
        ...reasons,
      }, outcome, outcome === 'successful' && result.auditRecorded));
    }

    const items = sortBulkReviewItems(executionItems);
    const summary = items.reduce(
      (result, item) => {
        result.total += 1;
        result[item.outcome] += 1;
        return result;
      },
      { total: 0, successful: 0, blocked: 0, already_complete: 0, invalid_or_stale: 0, failed: 0 },
    );

    return {
      action: params.action,
      summary: {
        total: summary.total,
        successful: summary.successful,
        blocked: summary.blocked,
        alreadyComplete: summary.already_complete,
        invalidOrStale: summary.invalid_or_stale,
        failed: summary.failed,
      },
      items,
    };
  }
}
