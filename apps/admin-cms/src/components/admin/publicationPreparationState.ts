export interface PublicationPlanEvidence {
  publicId: string;
  confirmedPreviewId: string;
  confirmedAt: string;
  recordCount: number;
  feedHash: string;
}

export interface PublicationSuccessEvidence {
  resultCode: 'COMPLETED' | 'ALREADY_COMPLETED';
  publicId: string;
  snapshotId: string;
  recordCount: number;
  feedHash: string;
}

export interface PublicationPreparationState {
  operation: 'idle' | 'planning' | 'executing';
  plan: PublicationPlanEvidence | null;
  acknowledged: boolean;
  error: string | null;
  success: PublicationSuccessEvidence | null;
}

export type PublicationPreparationEvent =
  | { type: 'PLAN_STARTED' }
  | { type: 'PLAN_SUCCEEDED'; plan: PublicationPlanEvidence }
  | { type: 'PLAN_FAILED'; error: string }
  | { type: 'ACKNOWLEDGEMENT_CHANGED'; acknowledged: boolean }
  | { type: 'EXECUTION_STARTED' }
  | { type: 'EXECUTION_SUCCEEDED'; result: PublicationSuccessEvidence }
  | { type: 'EXECUTION_FAILED'; error: string };

export const initialPublicationPreparationState: PublicationPreparationState = {
  operation: 'idle',
  plan: null,
  acknowledged: false,
  error: null,
  success: null,
};

export function publicationPreparationReducer(
  state: PublicationPreparationState,
  event: PublicationPreparationEvent,
): PublicationPreparationState {
  switch (event.type) {
    case 'PLAN_STARTED':
      return { ...initialPublicationPreparationState, operation: 'planning' };
    case 'PLAN_SUCCEEDED':
      return { ...initialPublicationPreparationState, plan: event.plan };
    case 'PLAN_FAILED':
      return { ...initialPublicationPreparationState, error: event.error };
    case 'ACKNOWLEDGEMENT_CHANGED':
      return { ...state, acknowledged: event.acknowledged };
    case 'EXECUTION_STARTED':
      return { ...state, operation: 'executing', error: null };
    case 'EXECUTION_SUCCEEDED':
      return { ...state, operation: 'idle', acknowledged: false, error: null, success: event.result };
    case 'EXECUTION_FAILED':
      return { ...initialPublicationPreparationState, error: event.error };
  }
}

export function shouldShowLocalExecution(
  canPrepare: boolean,
  localExecutionAvailable: boolean,
  state: PublicationPreparationState,
): boolean {
  return canPrepare && localExecutionAvailable && state.plan !== null;
}

export function canExecuteLocalPublication(
  canPrepare: boolean,
  localExecutionAvailable: boolean,
  state: PublicationPreparationState,
): boolean {
  return shouldShowLocalExecution(canPrepare, localExecutionAvailable, state) &&
    state.acknowledged && state.operation === 'idle' && state.success === null;
}
