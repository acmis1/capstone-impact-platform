import type { PreviewAccessEvidence } from '../../previews/participantPreviewAccessEvidence';

export function ParticipantPreviewAccessEvidence({ evidence }: { evidence: PreviewAccessEvidence }) {
  const timestamp = evidence.available ? evidence.firstResponsePreparedAt : null;
  const validTimestamp = timestamp !== null && Number.isFinite(Date.parse(timestamp));
  const unavailable = !evidence.available || (timestamp !== null && !validTimestamp);
  return (
    <aside aria-label="Preview access evidence" className="rounded-lg border border-border p-3 text-sm">
      <h3 className="font-semibold text-foreground">Preview access evidence</h3>
      {unavailable ? (
        <p className="text-muted-foreground">Access evidence is unavailable. No access rate can be inferred.</p>
      ) : timestamp ? (
        <p className="text-foreground">
          First complete response prepared:{' '}
          <time dateTime={timestamp}>
            {new Date(timestamp).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC
          </time>
        </p>
      ) : (
        <p className="text-muted-foreground">Not recorded. Earlier access may predate evidence collection.</p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        A server-prepared response is not a read receipt or confirmation. Automated requests may
        produce this observation; delivery and human review are not established by it.
      </p>
    </aside>
  );
}
