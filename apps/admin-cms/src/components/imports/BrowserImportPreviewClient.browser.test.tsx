// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BrowserImportPreviewClient browser evaluation', () => {
  it('imports and renders its initial controls without Node globals', async () => {
    vi.stubGlobal('Buffer', undefined);

    const { default: BrowserImportPreviewClient } = await import('./BrowserImportPreviewClient');
    render(<BrowserImportPreviewClient />);

    expect(
      screen.getByRole('heading', { name: '1. Select Project Folder or Batch Directory' })
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Choose Project Folder/ })).toBeTruthy();
  });
});
