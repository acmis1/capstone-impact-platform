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

/**
 * Stored filter preferences after a "Clear search and filters" operation.
 * Sort, direction, page size and column visibility are deliberately untouched.
 */
export const CLEARED_FILTER_PREFERENCES = {
  status: '',
  year: '',
  program: '',
  discipline: '',
} as const;

/**
 * Builds the URL for "Clear search and filters": removes the transient search term and every
 * supported filter, resets the page, and preserves sort, direction and page size.
 * Shared so the filter bar and the no-results state can never drift apart.
 */
export function buildClearFiltersQueryString(
  currentSearchParams: string | URLSearchParams
): string {
  return buildQueryString(currentSearchParams, {
    q: null,
    search: null,
    status: null,
    year: null,
    program: null,
    discipline: null,
  });
}
