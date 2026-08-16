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
    return { title: 'Ready for publication', description: 'The confirmed participant snapshot matches the current project information and private media.', variant: 'success', icon: CheckCircle2 };
  }

  switch (readiness.resultCode) {
    case 'NO_ACTIVE_PREVIEW':
      return { title: 'Participant preview required', description: 'Generate a participant preview before preparing publication.', variant: 'warning', icon: Clock3 };
    case 'PREVIEW_NOT_CONFIRMED':
      return { title: 'Waiting for participant confirmation', description: 'Publication remains blocked until the participant confirms the active preview.', variant: 'warning', icon: Clock3 };
    case 'CORRECTION_UNRESOLVED':
      return { title: 'Participant correction requires resolution', description: 'Resolve the participant correction before preparing publication.', variant: 'destructive', icon: AlertCircle };
    case 'CORRECTED_PREVIEW_AWAITING_CONFIRMATION':
      return { title: 'Corrected preview awaiting confirmation', description: 'The participant must confirm the corrected preview before publication can proceed.', variant: 'warning', icon: Clock3 };
    case 'PROJECT_SNAPSHOT_STALE':
      return { title: 'Project information changed after confirmation', description: 'A new participant confirmation is required for the current project information.', variant: 'destructive', icon: FileWarning };
    case 'MEDIA_SNAPSHOT_STALE':
      return { title: 'Project media changed after confirmation', description: 'A new participant confirmation is required for the current project media.', variant: 'destructive', icon: FileWarning };
    case 'INVALID_PROJECT_STATE':
      return { title: 'Project must be approved', description: 'Publication preparation is available only for an approved project.', variant: 'information', icon: ShieldAlert };
    case 'PROJECT_NOT_FOUND':
      return { title: 'Project unavailable', description: 'Publication readiness cannot be verified for this project.', variant: 'destructive', icon: AlertCircle };
    case 'READINESS_PERMISSION_DENIED':
      return { title: 'Readiness permission required', description: 'Publication readiness cannot be verified with the current access.', variant: 'destructive', icon: ShieldAlert };
    case 'INVALID_SELECTION':
    case 'INVALID_PRIVATE_BUCKET':
    case 'READINESS_UNAVAILABLE':
      return { title: 'Readiness unavailable', description: 'Publication preparation and local publication remain unavailable until readiness can be verified.', variant: 'information', icon: ShieldAlert };
    default:
      return { title: 'Not ready for publication', description: 'Publication readiness has not been satisfied.', variant: 'destructive', icon: AlertCircle };
  }
}

export function PublicationReadinessPanel({ readiness }: PublicationReadinessPanelProps) {
  if (!readiness) {
    return <Alert variant="information" icon={ShieldAlert} title="Publication readiness unavailable." description="Publication preparation and Local publication are disabled until readiness can be verified." />;
  }

  const presentation = getPresentation(readiness);

  return (
    <div className="flex flex-col gap-4 text-xs sm:text-sm">
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold text-foreground">Publication status</h4>
        <Alert variant={presentation.variant} icon={presentation.icon} title={presentation.title} description={presentation.description} />
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
          <h4 className="text-sm font-semibold text-foreground">Participant confirmation evidence</h4>
          <p className="mt-1 text-sm text-muted-foreground">Confirmed {new Date(readiness.confirmedAt).toLocaleString()}</p>
        </div>
      )}

      <details className="border-t border-border pt-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">Technical readiness evidence</summary>
        <div className="mt-2 flex items-center gap-2"><span>Result code</span><Badge variant="neutral" className="font-mono">{readiness.resultCode}</Badge></div>
      </details>
    </div>
  );
}
