// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PrePreviewPackageReplacement } from './PrePreviewPackageReplacement';
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('focuses an asynchronous upload error after the disabled fieldset is restored', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'The file content does not match a supported image or PDF.' }), { status: 400 })));
  const { container } = render(<PrePreviewPackageReplacement publicId="synthetic" view={{ available: true, candidate: null }} canSubmit />);
  screen.getByRole('button', { name: 'Upload complete replacement package' }).focus();
  fireEvent.submit(container.querySelector('form')!);
  const alert = await screen.findByRole('alert');
  await waitFor(() => expect(document.activeElement).toBe(alert));
  expect(alert.getAttribute('tabindex')).toBe('-1');
  expect(screen.getByRole('button', { name: 'Upload complete replacement package' }).hasAttribute('disabled')).toBe(false);
});
