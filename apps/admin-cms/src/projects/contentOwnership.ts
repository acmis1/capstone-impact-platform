/** Package-origin public content is authored by the project team. */
export const PARTICIPANT_CONTENT_OWNERSHIP_MESSAGE =
  'Project content is owned by the project team. Request a corrected submission rather than editing it here.';

export const PARTICIPANT_CONTENT_OWNED = {
  ok: false,
  code: 'PARTICIPANT_CONTENT_OWNED',
  message: PARTICIPANT_CONTENT_OWNERSHIP_MESSAGE,
} as const;
