import React from 'react';

/** Explicit UTC avoids silently displaying the server's timezone as the reader's local time. */
export function RecordTimestamp({ value, className }: { value?: string | null; className?: string }) {
  const timestamp = value ? new Date(value) : null;
  if (!timestamp || Number.isNaN(timestamp.getTime())) {
    return <span className={className}>Not recorded</span>;
  }
  const label = new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  }).format(timestamp);
  return <time className={className} dateTime={timestamp.toISOString()} title={value ?? undefined}>{label} UTC</time>;
}
