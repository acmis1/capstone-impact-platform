import React from 'react';
import type { AuditHistoryView, ProjectMetadataEventDetails } from '../../projects/projectDetailAuxiliaryData';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { getWorkflowStatusLabel } from './ProjectStatusBadge';

interface ProjectAuditHistoryProps {
  /** `null` means the audit read failed; an empty array means there is genuinely no history. */
  auditRecords: AuditHistoryView[] | null;
  /** Number of newest records shown before the native full-history disclosure. */
  initialVisibleCount?: number;
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  approve: 'Approved',
  request_changes: 'Changes requested',
  archive: 'Archived',
  update_metadata: 'Project information updated',
  submit_for_review: 'Submitted for review',
};

function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action.replace(/_/g, ' ');
}

/** Long free text keeps its own scroll container so one huge value cannot dominate the page. */
function LongValue({ label, value, tone }: { label: string; value: string; tone: 'before' | 'after' }) {
  return (
    <div className="mt-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div
        className={cn(
          'mt-0.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-inset p-2 text-xs leading-relaxed',
          tone === 'before' ? 'text-muted-foreground' : 'text-foreground'
        )}
      >
        {value}
      </div>
    </div>
  );
}

function MetadataChange({ field, details }: { field: string; details: ProjectMetadataEventDetails }) {
  const before = details.before[field as keyof typeof details.before];
  const after = details.after[field as keyof typeof details.after];

  if (field === 'background' || field === 'solution' || field === 'posterText' || field === 'accessibilityText') {
    return (
      <>
        <LongValue label="Previous" value={before ? String(before) : 'Not provided'} tone="before" />
        <LongValue label="New" value={after ? String(after) : 'Not provided'} tone="after" />
      </>
    );
  }

  if (field === 'program') {
    return (
      <p className="mt-1 text-xs leading-relaxed text-foreground">
        <span className="text-muted-foreground line-through">
          {((before as Record<string, unknown>)?.name as string) || 'Not provided'}
        </span>
        <span className="mx-1.5 text-muted-foreground" aria-hidden="true">to</span>
        <span className="font-medium">{((after as Record<string, unknown>)?.name as string) || 'Not provided'}</span>
      </p>
    );
  }

  if (field === 'disciplines' || field === 'industryCategories') {
    const beforeSet = new Set(((before as Record<string, unknown>[]) || []).map((x) => x.name as string));
    const afterSet = new Set(((after as Record<string, unknown>[]) || []).map((x) => x.name as string));
    const added = [...afterSet].filter((x) => !beforeSet.has(x));
    const removed = [...beforeSet].filter((x) => !afterSet.has(x));
    return (
      <div className="mt-1 space-y-0.5 text-xs leading-relaxed text-foreground">
        {added.length > 0 && <p>Added: {added.join(', ')}</p>}
        {removed.length > 0 && <p>Removed: {removed.join(', ')}</p>}
      </div>
    );
  }

  return (
    <p className="mt-1 break-words text-xs leading-relaxed text-foreground">
      <span className="text-muted-foreground line-through">{String(before)}</span>
      <span className="mx-1.5 text-muted-foreground" aria-hidden="true">to</span>
      <span className="font-medium">{String(after)}</span>
    </p>
  );
}

const DISCLOSURE_SUMMARY_CLASSES =
  'inline-flex min-h-[32px] cursor-pointer list-none items-center text-xs font-medium text-foreground-subtle underline decoration-dotted underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

function AuditEntry({ record }: { record: AuditHistoryView }) {
  const transitionRecorded = Boolean(record.fromStatus || record.toStatus);

  return (
    <li className="p-4 sm:px-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <span className="text-sm font-semibold text-foreground">{auditActionLabel(record.action)}</span>
        <time className="text-xs text-muted-foreground" dateTime={record.timestamp || undefined}>
          {record.timestamp ? new Date(record.timestamp).toLocaleString() : 'Time not recorded'}
        </time>
      </div>

      <p className="mt-1 break-words text-xs text-muted-foreground">
        By <span className="font-medium text-foreground-subtle">{record.actorFullName}</span>
        {record.actorEmail && <span> ({record.actorEmail})</span>}
      </p>

      {transitionRecorded && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge variant="neutral">{record.fromStatus ? getWorkflowStatusLabel(record.fromStatus) : 'None'}</Badge>
          <span className="text-xs text-muted-foreground">changed to</span>
          <Badge variant="neutral">{record.toStatus ? getWorkflowStatusLabel(record.toStatus) : 'None'}</Badge>
        </p>
      )}

      {record.comments && (
        <p className="mt-2 max-w-[80ch] whitespace-pre-wrap break-words border-l-2 border-border-strong pl-3 text-sm leading-relaxed text-foreground">
          {record.comments}
        </p>
      )}

      {record.metadataEventDetails && (
        <div className="mt-2.5">
          <p className="break-words text-xs text-muted-foreground">
            <span className="font-medium text-foreground-subtle">Changed fields:</span>{' '}
            {record.metadataEventDetails.changedFields.join(', ')}
          </p>
          <details className="mt-1.5">
            <summary className={DISCLOSURE_SUMMARY_CLASSES}>Show previous and new values</summary>
            <div className="mt-2 space-y-3 border-l-2 border-border-strong pl-3">
              {record.metadataEventDetails.changedFields.map((field) => (
                <div key={field}>
                  <span className="text-xs font-semibold capitalize text-foreground">{field}</span>
                  <MetadataChange field={field} details={record.metadataEventDetails!} />
                </div>
              ))}
            </div>
          </details>
        </div>
      )}

      {record.mediaAccessibilityEventDetails && (
        <div className="mt-2.5">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground-subtle">Changed:</span> Snapshot image alt text
          </p>
          <details className="mt-1.5">
            <summary className={DISCLOSURE_SUMMARY_CLASSES}>Show previous and new values</summary>
            <div className="mt-2 border-l-2 border-border-strong pl-3">
              <LongValue
                label="Previous"
                value={record.mediaAccessibilityEventDetails.before.snapshotAltText ?? 'Not previously provided'}
                tone="before"
              />
              <LongValue label="New" value={record.mediaAccessibilityEventDetails.after.snapshotAltText} tone="after" />
            </div>
          </details>
        </div>
      )}
    </li>
  );
}

/**
 * Change history rendered as a responsive event list rather than a table.
 *
 * Every field the previous table exposed is preserved — timestamp, action, actor, transition,
 * comments, metadata-update details, media-accessibility changes, and the previous/new values —
 * but the layout reflows at narrow widths instead of hiding columns, and decision/evidence text
 * is at least 12px.
 */
export function ProjectAuditHistory({ auditRecords, initialVisibleCount = 3 }: ProjectAuditHistoryProps) {
  if (auditRecords === null) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Change history is temporarily unavailable. The rest of this project remains usable.
      </p>
    );
  }

  if (auditRecords.length === 0) {
    return <p className="text-sm text-muted-foreground">No recorded changes for this project yet.</p>;
  }

  const recentRecords = auditRecords.slice(0, initialVisibleCount);
  const olderRecords = auditRecords.slice(initialVisibleCount);

  return (
    <div className="flex flex-col gap-3">
      {olderRecords.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Showing the {recentRecords.length} most recent of {auditRecords.length} recorded changes.
        </p>
      )}

      <ol
        aria-label={olderRecords.length > 0 ? 'Most recent changes' : 'Recorded changes'}
        className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card"
      >
        {recentRecords.map((record) => (
          <AuditEntry key={record.id} record={record} />
        ))}
      </ol>

      {olderRecords.length > 0 && (
        <details className="group rounded-xl border border-border bg-card">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:px-6">
            <span className="group-open:hidden">Show {olderRecords.length} older changes</span>
            <span className="hidden group-open:inline">Hide {olderRecords.length} older changes</span>
          </summary>
          <ol
            start={recentRecords.length + 1}
            aria-label="Older changes"
            className="divide-y divide-border border-t border-border"
          >
            {olderRecords.map((record) => (
              <AuditEntry key={record.id} record={record} />
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
