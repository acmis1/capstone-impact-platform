export type ParticipantPreviewExecutionErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'INVALID_PROJECT_STATE'
  | 'PERMISSION_DENIED'
  | 'ACTIVE_PREVIEW_EXISTS'
  | 'NO_ACTIVE_PREVIEW'
  | 'INPUT_INVALID'
  | 'RESPONSE_INVALID'
  | 'INTERNAL_FAILURE';

export class ParticipantPreviewExecutionError extends Error {
  readonly code: ParticipantPreviewExecutionErrorCode;

  constructor(code: ParticipantPreviewExecutionErrorCode) {
    super(`Participant preview execution failed: ${code}`);
    this.name = 'ParticipantPreviewExecutionError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
