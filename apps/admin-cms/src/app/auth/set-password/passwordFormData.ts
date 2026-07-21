/**
 * Helper to construct canonical password form data.
 * 
 * Safe sequence:
 * - Reads native submitted entries.
 * - Non-empty string entries take precedence.
 * - If native entry is missing, empty, or not a string, falls back to the controlled react component state.
 * - Sets the canonical keys "password" and "confirmation" in the resulting FormData.
 */
export function canonicalizePasswordFormData(
  formData: FormData,
  fallback: { password?: string; confirmation?: string }
): FormData {
  const result = new FormData();

  // Copy other form data fields if they exist
  for (const [key, value] of formData.entries()) {
    if (key !== 'password' && key !== 'confirmation') {
      result.append(key, value);
    }
  }

  // 1. Password processing
  const nativePassword = formData.get('password');
  if (typeof nativePassword === 'string' && nativePassword !== '') {
    result.set('password', nativePassword);
  } else {
    result.set('password', fallback.password || '');
  }

  // 2. Confirmation processing
  const nativeConfirmation = formData.get('confirmation');
  if (typeof nativeConfirmation === 'string' && nativeConfirmation !== '') {
    result.set('confirmation', nativeConfirmation);
  } else {
    result.set('confirmation', fallback.confirmation || '');
  }

  return result;
}

export interface PasswordFallback {
  password?: string;
  confirmation?: string;
}

/**
 * Intercepts form dispatch, builds canonical FormData, and returns/awaits dispatcher.
 */
export async function dispatchCanonicalPasswordFormData<T>(
  formData: FormData,
  fallback: PasswordFallback,
  dispatcher: (data: FormData) => T | Promise<T>
): Promise<T> {
  const canonicalData = canonicalizePasswordFormData(formData, fallback);
  return await dispatcher(canonicalData);
}
