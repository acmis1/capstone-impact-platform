export type ParticipantPreviewExecutionErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'INVALID_PROJECT_STATE'
  | 'PERMISSION_DENIED'
  | 'ACTIVE_PREVIEW_EXISTS'
  | 'NO_ACTIVE_PREVIEW'
  | 'CORRECTION_RESOLUTION_REQUIRED'
  | 'NO_CORRECTION_IN_PROGRESS'
  | 'NO_OPEN_CORRECTION'
  | 'AMBIGUOUS_CORRECTION_REQUEST'
  | 'CONFLICTING_ACTIVE_PREVIEW'
  /**
   * The project's snapshot image has no usable text alternative, so no confirmable preview may be
   * issued. Applies identically to an ordinary preview and a correction reissue.
   */
  | 'MEDIA_ACCESSIBILITY_REQUIRED'
  | 'PUBLICATION_IN_PROGRESS'
  | 'READINESS_UNAVAILABLE'
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
