/**
 * Single source of truth for the static semantic tinted surfaces used by the project-detail
 * review workspace.
 *
 * `designTokenContrast.test.ts` imports this map and recomputes the rendered,
 * alpha-composited contrast of each combination, so a tinted surface on this page cannot
 * silently regress below the 4.5:1 floor. Token names do not imply compliance: a semantic
 * foreground on a 10%-opacity semantic background of the same hue composites to roughly
 * 4.1-4.4:1, which is why these surfaces carry `text-foreground` or a `*-strong` token
 * and use the semantic hue for the (decorative, `aria-hidden`) icon and border only.
 */
export const PROJECT_DETAIL_SURFACE_CLASSES = {
  /** Blocking workflow state: submission blocked, unresolved blockers. */
  blocker: 'rounded-lg border border-destructive/40 bg-destructive/8 text-foreground',
  /** Cautionary but non-blocking: sandbox scope, unsaved edits, unverified readiness. */
  caution: 'rounded-lg border border-warning/40 bg-warning/8 text-foreground',
  /** Confirmed positive outcome: saved, submitted, transition completed. */
  affirm: 'rounded-lg border border-success/40 bg-success/8 text-foreground',
  /** Neutral contextual explanation attached to a workflow area. */
  context: 'rounded-lg border border-border bg-surface-inset text-foreground-subtle',
} as const;

/**
 * Token naming the surface these tinted panels are painted on. Every project-detail section
 * container is `bg-card`, so a tinted panel inside one composites over the card colour.
 */
export const PROJECT_DETAIL_SURFACE_TOKEN = 'card';

/**
 * Semantic foreground tokens used for meaningful (non-decorative) text on the project-detail
 * page, checked against the page background rather than a card. The workspace header and the
 * section rules sit directly on `--background`.
 */
export const PROJECT_DETAIL_PAGE_TEXT_CLASSES = {
  identity: 'text-foreground',
  supporting: 'text-muted-foreground',
  evidence: 'text-foreground-subtle',
} as const;

export const PROJECT_DETAIL_PAGE_SURFACE_TOKEN = 'background';
