/**
 * Shared presentation classes for admin media previews.
 *
 * Kept in one module so the poster, PDF, and snapshot tiles stay visually consistent and so
 * `designTokenContrast.test.ts` can verify the tinted blocking-state surface against the exact
 * utilities the components render. Meaning is always carried by an icon plus text, never by
 * colour alone.
 */
export const MEDIA_PREVIEW_CLASSES = {
  /** One media asset tile inside the media review grid. */
  tile: 'flex min-w-0 flex-col rounded-lg border border-border bg-card p-3',
  /** Asset-type caption at the top of a tile. */
  assetLabel: 'text-xs font-semibold uppercase tracking-wider text-foreground-subtle',
  /** Inset frame holding the rendered image or document so it can never overflow the tile. */
  frame: 'mt-2 overflow-hidden rounded-md border border-border bg-surface-inset p-2',
  /** Neutral loading/missing state message. */
  stateMessage: 'mt-2 flex items-start gap-2 text-sm leading-relaxed text-foreground-subtle',
  /** Missing required accessibility information: prominent, and never colour-only. */
  blockingState:
    'mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/8 p-2.5 text-sm font-medium leading-relaxed text-foreground',
} as const;

/** Media tiles are painted on the card surface, so tinted panels composite over it. */
export const MEDIA_PREVIEW_SURFACE_TOKEN = 'card';
