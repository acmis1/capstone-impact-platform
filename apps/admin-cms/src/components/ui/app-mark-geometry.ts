export const APP_MARK_VIEW_BOX = '0 0 32 32';
export const APP_MARK_CORNER_RADIUS = 7;

/**
 * A custom geometric CI monogram that remains legible without font rendering.
 * Both the application mark and the generated browser icon consume these exact paths.
 */
export const APP_MARK_PATHS = [
  'M8 8h10v4h-6v8h6v4H8V8Z',
  'M21 8h3v16h-3V8Z',
] as const;

/** Browser-icon colours mirror the primary design token and its foreground. */
export const APP_MARK_ICON_COLORS = {
  background: '#e61e2a',
  foreground: '#ffffff',
} as const;
