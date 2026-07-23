/**
 * Constructs a new URL search query string by applying key-value parameter updates.
 * Resets the 'page' parameter to 1 whenever filters or search change, unless 'page' is explicitly updated.
 */
export function buildQueryString(
  currentSearchParams: string | URLSearchParams,
  updates: Record<string, string | number | null | undefined>
): string {
  const params = new URLSearchParams(
    typeof currentSearchParams === 'string' ? currentSearchParams : currentSearchParams.toString()
  );

  Object.entries(updates).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') {
      params.delete(key);
    } else {
      params.set(key, String(value));
    }
  });

  // Reset page to 1 whenever search, filters, or pageSize change (unless page is explicitly updated)
  if (!('page' in updates)) {
    params.delete('page');
  }

  return params.toString();
}
