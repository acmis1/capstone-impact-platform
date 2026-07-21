export interface InputResolutionOptions {
  domPassword?: string;
  domConfirmation?: string;
  statePassword?: string;
  stateConfirmation?: string;
}

export function resolvePasswordInputs(options: InputResolutionOptions): { password: string; confirmation: string } {
  const password = (options.domPassword !== undefined && options.domPassword !== '') 
    ? options.domPassword 
    : (options.statePassword || '');

  const confirmation = (options.domConfirmation !== undefined && options.domConfirmation !== '') 
    ? options.domConfirmation 
    : (options.stateConfirmation || '');

  return { password, confirmation };
}

export function isRedirectError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'digest' in err) {
    const digest = String((err as { digest?: unknown }).digest || '');
    return digest.startsWith('NEXT_REDIRECT');
  }
  return false;
}
