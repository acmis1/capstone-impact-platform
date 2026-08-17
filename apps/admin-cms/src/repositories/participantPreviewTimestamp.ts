const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const POSTGRES_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}(?::\d{2})?$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Normalizes timestamps crossing the participant-preview repository boundary.
 *
 * Current database rows return ordinary RFC3339 strings. Some RPCs return PostgreSQL's strict text
 * form (space separator and an hour-only UTC offset), while legacy RPCs returned one JSON string
 * encoding of an RFC3339 value (including the quote characters). Those exact shapes are converted;
 * other JSON values, nested encodings, whitespace, and invalid calendar/time values fail closed.
 */
export function normalizeParticipantPreviewTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;

  let candidate = value;
  if (candidate.startsWith('"') || candidate.endsWith('"')) {
    if (!candidate.startsWith('"') || !candidate.endsWith('"')) return null;
    try {
      const decoded: unknown = JSON.parse(candidate);
      if (typeof decoded !== 'string') return null;
      candidate = decoded;
    } catch {
      return null;
    }
  }

  let parseableCandidate = candidate;
  if (!RFC3339_TIMESTAMP.test(parseableCandidate)) {
    if (!POSTGRES_TIMESTAMP.test(parseableCandidate)) return null;
    parseableCandidate = parseableCandidate
      .replace(' ', 'T')
      .replace(/([+-]\d{2})$/, '$1:00');
  }

  const match = RFC3339_TIMESTAMP.exec(parseableCandidate);
  if (!match) return null;

  const [, yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue, offsetHour, offsetMinute] = match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);

  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 ||
    (offsetHour !== undefined && Number(offsetHour) > 23) ||
    (offsetMinute !== undefined && Number(offsetMinute) > 59)
  ) {
    return null;
  }

  const instant = Date.parse(parseableCandidate);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}
