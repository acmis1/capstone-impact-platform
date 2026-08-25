// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PublicFeedHistoryPagination } from './PublicFeedHistoryPagination';

describe('PublicFeedHistoryPagination', () => {
  it('links older and newer bounded history pages without dropping navigation direction', () => {
    render(<PublicFeedHistoryPagination page={2} hasNewer hasOlder />);

    expect(screen.getByRole('link', { name: 'Newer versions' }).getAttribute('href'))
      .toBe('/admin/public-feed?page=1');
    expect(screen.getByRole('link', { name: 'Older versions' }).getAttribute('href'))
      .toBe('/admin/public-feed?page=3');
    expect(screen.getByText('Page 2')).not.toBeNull();
  });
});
