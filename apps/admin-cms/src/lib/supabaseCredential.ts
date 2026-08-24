export type PublicSupabaseCredentialType =
  | 'publishable'
  | 'legacy_anon_jwt'
  | 'missing'
  | 'unknown';

export type ServerSupabaseCredentialType =
  | 'secret'
  | 'legacy_service_role_jwt'
  | 'missing'
  | 'unknown';

export type SupabaseCredentialType =
  | PublicSupabaseCredentialType
  | ServerSupabaseCredentialType;

export type PublicSupabaseCredentialEnvironment = {
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
};

const PUBLIC_CREDENTIAL_ERROR =
  'Staging Configuration Error: Supabase browser credential configuration is unsafe.';

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

function isBase64UrlSegment(segment: string): boolean {
  return BASE64URL_SEGMENT.test(segment) && segment.length % 4 !== 1;
}

function decodeCanonicalBase64UrlUtf8(segment: string): string | undefined {
  if (!isBase64UrlSegment(segment)) return undefined;

  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(`${base64}${padding}`);
    const canonical = btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    if (canonical !== segment) return undefined;

    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

// This validates configured JWT payload semantics only; it does not authenticate the signature.
function legacyJwtHasRole(token: string, expectedRole: 'anon' | 'service_role'): boolean {
  const segments = token.split('.');
  if (
    segments.length !== 3 ||
    segments.some((segment) => !segment || !isBase64UrlSegment(segment))
  ) {
    return false;
  }

  const decodedPayload = decodeCanonicalBase64UrlUtf8(segments[1]);
  if (decodedPayload === undefined) return false;

  try {
    const payload: unknown = JSON.parse(decodedPayload);
    return (
      typeof payload === 'object' &&
      payload !== null &&
      !Array.isArray(payload) &&
      'role' in payload &&
      payload.role === expectedRole
    );
  } catch {
    return false;
  }
}

export function classifySupabaseCredential(
  key: string | undefined,
  isServerKey: false,
): PublicSupabaseCredentialType;
export function classifySupabaseCredential(
  key: string | undefined,
  isServerKey: true,
): ServerSupabaseCredentialType;
export function classifySupabaseCredential(
  key: string | undefined,
  isServerKey: boolean,
): SupabaseCredentialType {
  if (!key) return 'missing';

  if (!isServerKey && key.startsWith('sb_publishable_')) {
    return key.length > 'sb_publishable_'.length ? 'publishable' : 'unknown';
  }
  if (isServerKey && key.startsWith('sb_secret_')) {
    return key.length > 'sb_secret_'.length ? 'secret' : 'unknown';
  }
  if (legacyJwtHasRole(key, isServerKey ? 'service_role' : 'anon')) {
    return isServerKey ? 'legacy_service_role_jwt' : 'legacy_anon_jwt';
  }

  return 'unknown';
}

export function assertPublicSupabaseCredentialsAreSafe(
  environment: PublicSupabaseCredentialEnvironment,
): void {
  const configuredCredentials = [
    environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    environment.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  ].filter((credential): credential is string => Boolean(credential));

  if (
    configuredCredentials.some((credential) => {
      const type = classifySupabaseCredential(credential, false);
      return type !== 'publishable' && type !== 'legacy_anon_jwt';
    })
  ) {
    throw new Error(PUBLIC_CREDENTIAL_ERROR);
  }
}
