import { isIP } from 'node:net';

export type StagingRuntimeEnvironment = Record<string, string | undefined>;

function ipv6Segments(address: string): number[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (value: string): number[] | null => {
    if (value === '') return [];
    const segments: number[] = [];
    for (const part of value.split(':')) {
      if (/^[0-9a-f]{1,4}$/i.test(part)) {
        segments.push(Number.parseInt(part, 16));
        continue;
      }
      if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(part)) {
        const octets = part.split('.').map(Number);
        if (octets.some((octet) => octet < 0 || octet > 255)) return null;
        segments.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      return null;
    }
    return segments;
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === 'localhost.') return true;
  if (isIP(normalized) === 4) return Number(normalized.split('.')[0]) === 127;
  if (isIP(normalized) !== 6) return false;
  const segments = ipv6Segments(normalized);
  if (!segments) return false;
  const ipv6Loopback = segments.slice(0, 7).every((segment) => segment === 0)
    && segments[7] === 1;
  const mappedIpv4Loopback = segments.slice(0, 5).every((segment) => segment === 0)
    && (segments[5] === 0 || segments[5] === 0xffff)
    && (segments[6] >> 8) === 127;
  return ipv6Loopback || mappedIpv4Loopback;
}

export function isStagingRuntimeEnvironment(
  env: StagingRuntimeEnvironment = process.env,
): boolean {
  return env.CAPSTONE_RUNTIME_ENV === 'staging';
}

/**
 * Verifies the shared staging runtime and Supabase target identity without applying any
 * CLI-specific mutation acknowledgement semantics.
 */
export function assertVerifiedStagingRuntime(
  env: StagingRuntimeEnvironment = process.env,
): void {
  if (!isStagingRuntimeEnvironment(env)) {
    throw new Error(
      'Staging Execution Refused: Environment identity is not configured for staging operations.',
    );
  }

  const expectedHost = env.CAPSTONE_EXPECTED_SUPABASE_HOST;
  if (!expectedHost || expectedHost === '' || expectedHost !== expectedHost.trim()
      || expectedHost.endsWith('.')) {
    throw new Error('Staging Execution Refused: Expected target hostname is not configured.');
  }

  const expectedOrigin = `https://${expectedHost}`;
  let parsedExpectedOrigin: URL;
  try {
    parsedExpectedOrigin = new URL(expectedOrigin);
  } catch {
    throw new Error('Staging Execution Refused: Expected target hostname is invalid.');
  }
  if (parsedExpectedOrigin.origin !== expectedOrigin
      || parsedExpectedOrigin.hostname !== expectedHost
      || parsedExpectedOrigin.pathname !== '/') {
    throw new Error('Staging Execution Refused: Expected target hostname is not canonical.');
  }

  const supabaseUrlRaw = env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrlRaw || !supabaseUrlRaw.trim()) {
    throw new Error('Staging Execution Refused: Required Supabase URL variable is missing.');
  }
  if (supabaseUrlRaw !== supabaseUrlRaw.trim()) {
    throw new Error('Staging Execution Refused: Target Supabase URL is not canonical.');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(supabaseUrlRaw);
  } catch {
    throw new Error('Staging Execution Refused: Invalid target Supabase URL structure.');
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new Error('Staging Execution Refused: Target URL must use secure HTTPS protocol.');
  }

  if (isLoopbackHost(parsedUrl.hostname)) {
    throw new Error('Staging Execution Refused: Staging operations cannot target loopback endpoints.');
  }

  if (parsedUrl.hostname !== expectedHost) {
    throw new Error(
      'Staging Execution Refused: Target hostname does not match expected staging target identity.',
    );
  }

  if (parsedUrl.username !== '' || parsedUrl.password !== '' || parsedUrl.port !== ''
      || parsedUrl.pathname !== '/' || parsedUrl.search !== '' || parsedUrl.hash !== ''
      || (supabaseUrlRaw !== expectedOrigin && supabaseUrlRaw !== `${expectedOrigin}/`)) {
    throw new Error('Staging Execution Refused: Target Supabase URL is not the approved canonical base URL.');
  }
}

/** Fail-closed boolean form for server-rendered and route-handler eligibility checks. */
export function isVerifiedStagingRuntime(
  env: StagingRuntimeEnvironment = process.env,
): boolean {
  try {
    assertVerifiedStagingRuntime(env);
    return true;
  } catch {
    return false;
  }
}
