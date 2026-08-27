import React from 'react';
import { AlertCircle, CheckCircle2, Clock3, FileWarning, ShieldAlert } from 'lucide-react';
import { PublicationReadinessResult } from '../../domain/publicationReadiness';
import { Alert } from '../ui/alert';
import { Badge } from '../ui/badge';

interface PublicationReadinessPanelProps {
  readiness: PublicationReadinessResult | null;
}

type ReadinessPresentation = {
  title: string;
  description: string;
  variant: 'success' | 'warning' | 'destructive' | 'information';
  icon: typeof CheckCircle2;
};

function getPresentation(readiness: PublicationReadinessResult): ReadinessPresentation {
  if (readiness.ready && readiness.resultCode === 'READY') {
    return {
      title: 'Ready to publish',
      description: 'All requirements are met. The project can now be reviewed and published to the test showcase.',
      variant: 'success',
      icon: CheckCircle2,
    };
  }

  switch (readiness.resultCode) {
    case 'NO_ACTIVE_PREVIEW':
      return {
        title: 'Participant preview required',
        description: 'A participant preview must be created and shared before this project can be published.',
        variant: 'warning',
        icon: Clock3,
      };
    case 'PREVIEW_NOT_CONFIRMED':
      return {
        title: 'Waiting for participant confirmation',
        description: 'The project cannot be published until the participant confirms the preview.',
        variant: 'warning',
        icon: Clock3,
      };
    case 'CORRECTION_UNRESOLVED':
      return {
        title: 'Participant correction requires resolution',
        description: 'A participant correction request must be resolved before publishing.',
        variant: 'destructive',
        icon: AlertCircle,
      };
    case 'CORRECTED_PREVIEW_AWAITING_CONFIRMATION':
      return {
        title: 'Corrected preview awaiting confirmation',
        description: 'The participant must confirm the updated preview before publication can proceed.',
        variant: 'warning',
        icon: Clock3,
      };
    case 'PROJECT_SNAPSHOT_STALE':
      return {
        title: 'Project information changed after confirmation',
        description: 'Project information was edited after confirmation. A new participant confirmation is required.',
        variant: 'destructive',
        icon: FileWarning,
      };
    case 'MEDIA_SNAPSHOT_STALE':
      return {
        title: 'Project media changed after confirmation',
        description: 'Project media files were updated after confirmation. A new participant confirmation is required.',
        variant: 'destructive',
        icon: FileWarning,
      };
    case 'INVALID_PROJECT_STATE':
      return {
        title: 'Project must be approved',
        description: 'The project must be approved through the review workflow before publication.',
        variant: 'information',
        icon: ShieldAlert,
      };
    case 'PROJECT_NOT_FOUND':
      return {
        title: 'Project unavailable',
        description: 'Publication readiness cannot be verified for this project.',
        variant: 'destructive',
        icon: AlertCircle,
      };
    case 'READINESS_PERMISSION_DENIED':
      return {
        title: 'Publishing permission required',
        description: 'You do not have permission to prepare or publish projects.',
        variant: 'destructive',
        icon: ShieldAlert,
      };
    case 'INVALID_SELECTION':
    case 'INVALID_PRIVATE_BUCKET':
    case 'READINESS_UNAVAILABLE':
      return {
        title: 'Readiness check unavailable',
        description: 'Publication readiness cannot be verified right now. Please try again shortly.',
        variant: 'information',
        icon: ShieldAlert,
      };
    default:
      return {
        title: 'Not ready to publish',
        description: 'Publication readiness requirements have not been satisfied yet.',
        variant: 'destructive',
        icon: AlertCircle,
      };
  }
}

export type ChecklistItemState = 'passed' | 'failed' | 'unverified';

export interface ReadinessChecklistData {
  approved: ChecklistItemState;
  confirmed: ChecklistItemState;
  detailsMatch: ChecklistItemState;
}

const APPROVED_CODES = new Set([
  'READY',
  'PROJECT_SNAPSHOT_STALE',
  'MEDIA_SNAPSHOT_STALE',
  'NO_ACTIVE_PREVIEW',
  'PREVIEW_NOT_CONFIRMED',
  'CORRECTED_PREVIEW_AWAITING_CONFIRMATION',
]);

const CONFIRMED_CODES = new Set([
  'READY',
  'PROJECT_SNAPSHOT_STALE',
  'MEDIA_SNAPSHOT_STALE',
]);

const UNCONFIRMED_CODES = new Set([
  'NO_ACTIVE_PREVIEW',
  'PREVIEW_NOT_CONFIRMED',
  'CORRECTED_PREVIEW_AWAITING_CONFIRMATION',
]);

const STALE_CODES = new Set([
  'PROJECT_SNAPSHOT_STALE',
  'MEDIA_SNAPSHOT_STALE',
]);

export function deriveReadinessChecklist(readiness: PublicationReadinessResult): ReadinessChecklistData {
  const { resultCode, ready, confirmedAt } = readiness;

  let approved: ChecklistItemState = 'unverified';
  if (APPROVED_CODES.has(resultCode)) {
    approved = 'passed';
  } else if (resultCode === 'INVALID_PROJECT_STATE') {
    approved = 'failed';
  }

  let confirmed: ChecklistItemState = 'unverified';
  if (CONFIRMED_CODES.has(resultCode) && Boolean(confirmedAt)) {
    confirmed = 'passed';
  } else if (UNCONFIRMED_CODES.has(resultCode)) {
    confirmed = 'failed';
  }

  let detailsMatch: ChecklistItemState = 'unverified';
  if (resultCode === 'READY' && ready) {
    detailsMatch = 'passed';
  } else if (STALE_CODES.has(resultCode)) {
    detailsMatch = 'failed';
  }

  return { approved, confirmed, detailsMatch };
}

const CHECKLIST_STATE_LABELS: Record<ChecklistItemState, string> = {
  passed: 'Passed',
  failed: 'Needs attention',
  unverified: 'Not yet verified',
};

const CHECKLIST_STATE_GLYPHS: Record<ChecklistItemState, string> = {
  passed: '✓',
  failed: '✕',
  unverified: '○',
};

const CHECKLIST_STATE_CLASSES: Record<ChecklistItemState, string> = {
  passed: 'font-bold text-success',
  failed: 'font-bold text-destructive',
  unverified: 'text-muted-foreground',
};

/**
 * Checklist state is carried by a real text label, not by an `aria-label` on a generic span:
 * `aria-label` is not reliably exposed on elements without a role. The glyph is decorative and
 * hidden from assistive technology, so state is never communicated by colour or shape alone.
 */
function ChecklistItem({ state, children }: { state: ChecklistItemState; children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
      <span className="flex min-w-0 items-start gap-2">
        <span className={`${CHECKLIST_STATE_CLASSES[state]} leading-6`} aria-hidden="true">
          {CHECKLIST_STATE_GLYPHS[state]}
        </span>
        <span className={state === 'passed' ? 'text-foreground' : 'text-muted-foreground'}>{children}</span>
      </span>
      <span className={`shrink-0 text-xs font-semibold leading-6 ${CHECKLIST_STATE_CLASSES[state]}`}>
        {CHECKLIST_STATE_LABELS[state]}
      </span>
    </li>
  );
}

export function PublicationReadinessPanel({ readiness }: PublicationReadinessPanelProps) {
  if (!readiness) {
    return (
      <Alert
        variant="information"
        icon={ShieldAlert}
        title="Publication readiness unavailable."
        description="Publication preparation and execution are disabled until readiness can be verified."
      />
    );
  }

  const presentation = getPresentation(readiness);
  const checklist = deriveReadinessChecklist(readiness);

  return (
    <div className="flex flex-col gap-4 text-xs sm:text-sm">
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold text-foreground">Publication readiness</h4>
        <Alert variant={presentation.variant} icon={presentation.icon} title={presentation.title} description={presentation.description} />
      </div>

      {/* Truthful Readiness Checklist */}
      <div className="rounded-lg border border-border bg-card p-3.5">
        <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Publication requirements</h5>
        <ul className="mt-2.5 space-y-2 text-sm">
          <ChecklistItem state={checklist.approved}>Project approved</ChecklistItem>
          <ChecklistItem state={checklist.confirmed}>
            {checklist.confirmed === 'passed' && readiness.confirmedAt
              ? `Participant confirmation received (${new Date(readiness.confirmedAt).toLocaleDateString()})`
              : 'Participant confirmation received'}
          </ChecklistItem>
          <ChecklistItem state={checklist.detailsMatch}>
            Project details and media match confirmation
          </ChecklistItem>
        </ul>
      </div>

      {readiness.blockers.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold text-foreground">What is blocking publication</h4>
          <ul className="list-disc space-y-1 pl-5 text-sm text-foreground marker:text-destructive">
            {readiness.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}
          </ul>
        </div>
      )}

      {readiness.confirmedAt && (
        <div className="border-t border-border pt-3">
          <h4 className="text-sm font-semibold text-foreground">Participant confirmation</h4>
          <p className="mt-1 text-sm text-muted-foreground">Confirmed {new Date(readiness.confirmedAt).toLocaleString()}</p>
        </div>
      )}

      <details className="border-t border-border pt-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">Technical details</summary>
        <div className="mt-2 flex items-center gap-2">
          <span>Result code:</span>
          <Badge variant="neutral" className="font-mono">{readiness.resultCode}</Badge>
        </div>
      </details>
    </div>
  );
}
