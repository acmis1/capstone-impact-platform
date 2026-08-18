/**
 * Single source of truth for the import workflow step-tracker state classes.
 *
 * `ImportWorkflowGuide` renders these verbatim, and `designTokenContrast.test.ts`
 * imports them so the rendered current-step foreground/background combination is
 * contrast-verified against the exact utilities the component uses. Keeping the
 * class strings here means the contrast guard cannot silently go stale if the
 * step-tracker styling changes.
 */
export const IMPORT_WORKFLOW_STEP_ITEM_CLASSES = {
  current: 'bg-primary/10 text-foreground font-semibold border border-primary/20',
  completed: 'text-foreground font-medium',
  upcoming: 'text-muted-foreground',
} as const;

/** Classes for the small numbered/checked circle preceding each step label. */
export const IMPORT_WORKFLOW_STEP_MARKER_CLASSES = {
  current: 'bg-primary text-primary-foreground',
  completed: 'bg-success text-success-foreground',
  upcoming: 'bg-muted text-muted-foreground',
} as const;

/**
 * Design token naming the surface the step tracker is painted on. The tracker
 * `<nav>` uses `bg-card`, so any tinted step background composites over it.
 */
export const IMPORT_WORKFLOW_STEP_SURFACE_TOKEN = 'card';
