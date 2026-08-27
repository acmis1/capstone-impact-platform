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

  const isApproved = readiness.resultCode !== 'INVALID_PROJECT_STATE';
  const isConfirmed = Boolean(readiness.confirmedAt);
  const isNotStale = readiness.resultCode !== 'PROJECT_SNAPSHOT_STALE'
    && readiness.resultCode !== 'MEDIA_SNAPSHOT_STALE'
    && readiness.resultCode !== 'CORRECTION_UNRESOLVED';

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
          <li className="flex items-center gap-2">
            <span className={isApproved ? 'text-success font-bold' : 'text-muted-foreground'}>
              {isApproved ? '✓' : '○'}
            </span>
            <span className={isApproved ? 'text-foreground' : 'text-muted-foreground'}>Project approved</span>
          </li>
          <li className="flex items-center gap-2">
            <span className={isConfirmed ? 'text-success font-bold' : 'text-muted-foreground'}>
              {isConfirmed ? '✓' : '○'}
            </span>
            <span className={isConfirmed ? 'text-foreground' : 'text-muted-foreground'}>
              {isConfirmed ? `Participant confirmation received (${new Date(readiness.confirmedAt!).toLocaleDateString()})` : 'Participant confirmation received'}
            </span>
          </li>
          <li className="flex items-center gap-2">
            <span className={isNotStale && readiness.ready ? 'text-success font-bold' : 'text-muted-foreground'}>
              {isNotStale && readiness.ready ? '✓' : '○'}
            </span>
            <span className={isNotStale && readiness.ready ? 'text-foreground' : 'text-muted-foreground'}>Project details and media match confirmation</span>
          </li>
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
