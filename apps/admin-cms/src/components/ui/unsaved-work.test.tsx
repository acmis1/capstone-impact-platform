// @vitest-environment jsdom
import React from 'react';
import { render, fireEvent, screen, cleanup, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUnsavedWorkGuard } from './unsaved-work';

function Harness({ dirty = true, navigate = vi.fn() }: { dirty?: boolean; navigate?: (href: string) => void }) {
  const guard = useUnsavedWorkGuard({ dirty, onDiscard: vi.fn(), navigate });
  return <><button onClick={() => guard.requestAction(() => navigate('/elsewhere'))}>Leave page</button><a href="/elsewhere">Elsewhere</a>{guard.dialog}</>;
}
function navigationFixture() {
  const events = new EventTarget();
  const traverseTo = vi.fn(() => ({ committed: Promise.resolve(), finished: Promise.resolve() }));
  Object.defineProperty(window, 'navigation', { configurable: true, value: Object.assign(events, { traverseTo }) });
  function traverse(cancelable = true) {
    const event = new Event('navigate', { cancelable });
    Object.assign(event, { navigationType: 'traverse', hashChange: false, destination: { key: 'earlier-page', url: new URL('/earlier-page', location.origin).href } });
    act(() => events.dispatchEvent(event));
    return event;
  }
  return { traverse, traverseTo };
}
afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'navigation'); vi.restoreAllMocks(); });

describe('unsaved work traversal and explicit departure', () => {
  it('cancels a native Back/Forward attempt without changing history; discard resumes exact entry once', () => {
    const native = navigationFixture();
    const pushState = vi.spyOn(history, 'pushState');
    const replaceState = vi.spyOn(history, 'replaceState');
    render(<Harness />);
    expect(native.traverse().defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(native.traverseTo).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    native.traverse();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(native.traverseTo).toHaveBeenCalledExactlyOnceWith('earlier-page');
    expect(native.traverse().defaultPrevented).toBe(false);
  });
  it('does not pretend a browser-forced non-cancelable traversal was stopped', () => {
    const native = navigationFixture();
    render(<Harness />);
    expect(native.traverse(false).defaultPrevented).toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it('does not show a second native unload prompt during an explicitly confirmed departure', () => {
    let prevented: boolean | undefined;
    render(<Harness navigate={() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); prevented = event.defaultPrevented; }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Leave page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(prevented).toBe(false);
  });
  it('does not intercept clean traversal or modified link clicks', () => {
    const native = navigationFixture();
    render(<Harness dirty={false} />);
    expect(native.traverse().defaultPrevented).toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
