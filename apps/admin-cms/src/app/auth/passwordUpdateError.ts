import { isAuthWeakPasswordError } from '@supabase/supabase-js';

export function isCompromisedPasswordError(error: unknown): boolean {
  return (
    isAuthWeakPasswordError(error) &&
    error.code === 'weak_password' &&
    error.reasons.includes('pwned')
  );
}
