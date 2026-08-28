'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '../../lib/supabase/client';
import { finalizeImplicitRecoveryAction } from './recoveryActions';

const MAX_RECOVERY_FRAGMENT_LENGTH = 20_000;
const MAX_RECOVERY_TOKEN_LENGTH = 8_192;
const RECOVERY_FAILURE_PATH = '/login?error=RECOVERY_LINK_INVALID';
const RECOVERY_PASSWORD_PATH = '/auth/reset-password';

export type ImplicitRecoveryFragment =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'recovery'; accessToken: string; refreshToken: string };

/**
 * Parses only Supabase's legacy/default-template recovery fragment. Other hash
 * fragments are ignored so this compatibility bridge cannot become a general
 * implicit-auth entry point.
 */
export function parseImplicitRecoveryFragment(hash: string): ImplicitRecoveryFragment {
  if (!hash || hash === '#') return { kind: 'none' };
  if (hash.length > MAX_RECOVERY_FRAGMENT_LENGTH) {
    return hash.includes('type=recovery') ? { kind: 'invalid' } : { kind: 'none' };
  }

  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  const types = params.getAll('type');

  if (types.length === 0 || types[0] !== 'recovery') {
    return { kind: 'none' };
  }
  if (types.length !== 1) return { kind: 'invalid' };

  const accessTokens = params.getAll('access_token');
  const refreshTokens = params.getAll('refresh_token');
  if (accessTokens.length !== 1 || refreshTokens.length !== 1) {
    return { kind: 'invalid' };
  }

  const accessToken = accessTokens[0];
  const refreshToken = refreshTokens[0];
  if (
    !accessToken ||
    !refreshToken ||
    accessToken.length > MAX_RECOVERY_TOKEN_LENGTH ||
    refreshToken.length > MAX_RECOVERY_TOKEN_LENGTH
  ) {
    return { kind: 'invalid' };
  }

  return { kind: 'recovery', accessToken, refreshToken };
}

function scrubHashFromAddressBar(): void {
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}`,
  );
}

/**
 * Hosted Supabase Free projects can still emit the default implicit recovery URL
 * when the hosted Auth template/redirect configuration has not been customized.
 * The fragment is browser-only, so capture it on the public login page, remove it
 * from the address bar immediately, establish the browser session, then ask the
 * server to prove recovery provenance before allowing the reset form.
 */
export function LegacyRecoveryBridge() {
  const router = useRouter();
  const handledRef = useRef(false);

  useEffect(() => {
    if (handledRef.current) return;

    const recovery = parseImplicitRecoveryFragment(window.location.hash);
    if (recovery.kind === 'none') return;

    handledRef.current = true;
    scrubHashFromAddressBar();

    if (recovery.kind === 'invalid') {
      router.replace(RECOVERY_FAILURE_PATH);
      return;
    }

    void (async () => {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.setSession({
        access_token: recovery.accessToken,
        refresh_token: recovery.refreshToken,
      });

      if (error) {
        try {
          await supabase.auth.signOut({ scope: 'local' });
        } catch {
          // The server never receives an accepted recovery context in this branch.
        }
        router.replace(RECOVERY_FAILURE_PATH);
        return;
      }

      const result = await finalizeImplicitRecoveryAction();
      router.replace(result.ok ? RECOVERY_PASSWORD_PATH : RECOVERY_FAILURE_PATH);
    })().catch(() => {
      router.replace(RECOVERY_FAILURE_PATH);
    });
  }, [router]);

  return null;
}
