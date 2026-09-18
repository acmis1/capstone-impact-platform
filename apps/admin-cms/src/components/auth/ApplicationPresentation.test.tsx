// @vitest-environment jsdom
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRuntimeDisplayEnvironment, SCHOOL_NAME } from '../../domain/institution';
import { AuthEnvironmentBadge, RuntimeEnvironmentPresentation } from './RuntimeEnvironmentPresentation';
import { AuthPageShell } from './AuthPageShell';
import ErrorPage from '../../app/error';
import NotFound from '../../app/not-found';

afterEach(cleanup);
describe('staff identity and safe page recovery', () => {
  it.each([['staging', 'Staging environment'], ['production', 'Production-designated environment'], ['local', 'Local development environment'], ['unexpected secret value', 'Environment not configured']])('renders only the allowlisted label for %s', (raw, label) => {
    render(<RuntimeEnvironmentPresentation environment={parseRuntimeDisplayEnvironment(raw)}><AuthEnvironmentBadge /></RuntimeEnvironmentPresentation>);
    expect(screen.getByText(label)).toBeTruthy();
    if (raw === 'unexpected secret value') expect(screen.queryByText(raw)).toBeNull();
  });
  it('uses the SSET organisation and one semantic primary heading in the auth shell', () => {
    render(<AuthPageShell title="Set up your password" description="Synthetic account setup"><p>Test content</p></AuthPageShell>);
    expect(screen.getByText(SCHOOL_NAME)).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByText('School of Computing Technologies')).toBeNull();
  });
  it('renders no raw exception and retries only on explicit user action', () => {
    const retry = vi.fn();
    render(<ErrorPage retry={retry} error={new Error('PRIVATE_EXCEPTION_SENTINEL')} />);
    expect(screen.queryByText('PRIVATE_EXCEPTION_SENTINEL')).toBeNull();
    expect(retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading page' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Return to Projects' }).getAttribute('href')).toBe('/admin');
    expect(screen.getByText(/does not confirm whether a previous action succeeded/)).toBeTruthy();
  });
  it('provides a genuine not-found heading and navigation without a fake retry', () => {
    render(<NotFound />);
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });
});
