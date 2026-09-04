/** @vitest-environment jsdom */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MultiSelect, MultiSelectOption } from '../multi-select';

const sampleOptions: MultiSelectOption[] = [
  { id: 'disc-1', name: 'Computer Science' },
  { id: 'disc-2', name: 'Software Engineering' },
  { id: 'disc-3', name: 'Data Science' },
  { id: 'disc-4', name: 'Cybersecurity' },
  { id: 'disc-5', name: 'Information Systems' },
];

afterEach(cleanup);

function renderMultiSelect(overrides: Partial<React.ComponentProps<typeof MultiSelect>> = {}) {
  const onChange = overrides.onChange ?? vi.fn();
  render(
    <MultiSelect
      id="test-disciplines"
      label="Disciplines"
      options={sampleOptions}
      value={[]}
      {...overrides}
      onChange={onChange}
    />
  );
  return { onChange };
}

describe('MultiSelect accessible structure', () => {
  it('gives the trigger a truthful accessible name that states the selection count', () => {
    renderMultiSelect({ value: [] });

    expect(screen.getByRole('button', { name: 'Disciplines: None selected' })).toBeTruthy();

    cleanup();
    renderMultiSelect({ value: ['disc-1', 'disc-2'] });

    expect(screen.getByRole('button', { name: 'Disciplines: 2 selected' })).toBeTruthy();
  });

  it('opens a dialog popup rather than a listbox, and never emits listbox or option roles', () => {
    renderMultiSelect({ value: ['disc-1'] });

    const trigger = screen.getByRole('button', { name: /^Disciplines:/ });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('dialog', { name: 'Disciplines options' });
    expect(panel).toBeTruthy();
    expect(trigger.getAttribute('aria-controls')).toBe(panel.getAttribute('id'));

    // A listbox may not contain a search field, a clear-search button or a footer action, so this
    // popup does not claim listbox semantics at all.
    expect(screen.queryAllByRole('listbox')).toHaveLength(0);
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('exposes every selectable value as a real checkbox carrying its own checked state', () => {
    renderMultiSelect({ value: ['disc-1'] });

    fireEvent.click(screen.getByRole('button', { name: /^Disciplines:/ }));
    const group = screen.getByRole('group', { name: 'Disciplines' });

    const selected = within(group).getByRole('checkbox', { name: 'Computer Science' }) as HTMLInputElement;
    const unselected = within(group).getByRole('checkbox', { name: 'Software Engineering' }) as HTMLInputElement;

    // Selection is carried by native checked state, not by colour alone.
    expect(selected.checked).toBe(true);
    expect(unselected.checked).toBe(false);
    expect(within(group).getAllByRole('checkbox')).toHaveLength(sampleOptions.length);
  });

  it('bounds the popup to the height Radix reports as available', () => {
    renderMultiSelect();

    fireEvent.click(screen.getByRole('button', { name: /^Disciplines:/ }));
    const panel = screen.getByRole('dialog', { name: 'Disciplines options' });

    // Without this bound the panel can be taller than the space above and below the trigger and
    // spill out of the viewport on short screens; the option list absorbs the difference instead.
    expect(panel.className).toContain('max-h-[var(--radix-popover-content-available-height)]');
    expect(screen.getByRole('group', { name: 'Disciplines' }).className).toContain('overflow-y-auto');
  });

  it('labels the search field and keeps it outside the option group', () => {
    renderMultiSelect();

    fireEvent.click(screen.getByRole('button', { name: /^Disciplines:/ }));
    const search = screen.getByLabelText('Search disciplines');
    const group = screen.getByRole('group', { name: 'Disciplines' });

    expect(search).toBeTruthy();
    expect(group.contains(search)).toBe(false);
  });

  it('gives the search field the design-system focus-visible contract', () => {
    renderMultiSelect();

    fireEvent.click(screen.getByRole('button', { name: /^Disciplines:/ }));
    const search = screen.getByLabelText('Search disciplines');

    expect(search.className).toContain('focus-visible:ring-2');
    expect(search.className).toContain('focus-visible:ring-ring');
  });

  it('names the selected chips and their removal buttons', () => {
    renderMultiSelect({ value: ['disc-1', 'disc-2'] });

    const chips = screen.getByRole('list', { name: 'Selected disciplines' });
    expect(within(chips).getAllByRole('listitem')).toHaveLength(2);
    expect(within(chips).getByRole('button', { name: 'Remove Computer Science' })).toBeTruthy();
    expect(within(chips).getByRole('button', { name: 'Remove Software Engineering' })).toBeTruthy();
  });
});

describe('MultiSelect selection behaviour', () => {
  it('adds a value with a single activation and no modifier key', () => {
    const { onChange } = renderMultiSelect({ value: ['disc-1'] });

    fireEvent.click(screen.getByRole('button', { name: /^Disciplines:/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Software Engineering' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['disc-1', 'disc-2']);
  });

  it('removes a value when its checkbox is unchecked', () => {
    const { onChange } = renderMultiSelect({ value: ['disc-1', 'disc-2'] });

    fireEvent.click(screen.getByRole('button', { name: /^Disciplines:/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Computer Science' }));

    expect(onChange).toHaveBeenCalledWith(['disc-2']);
  });

  it('removes a value from its chip without opening the popup', () => {
    const { onChange } = renderMultiSelect({ value: ['disc-1', 'disc-2'] });

    fireEvent.click(screen.getByRole('button', { name: 'Remove Computer Science' }));

    expect(onChange).toHaveBeenCalledWith(['disc-2']);
    expect(screen.getByRole('button', { name: /^Disciplines:/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('filters the option group from the search field and can clear the search', () => {
    renderMultiSelect();

    fireEvent.click(screen.getByRole('button', { name: /^Disciplines:/ }));
    fireEvent.change(screen.getByLabelText('Search disciplines'), { target: { value: 'cyber' } });

    expect(screen.getByRole('checkbox', { name: 'Cybersecurity' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Computer Science' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(screen.getByRole('checkbox', { name: 'Computer Science' })).toBeTruthy();
  });

  it('clears every selection from the footer action', () => {
    const { onChange } = renderMultiSelect({ value: ['disc-1', 'disc-2'] });

    fireEvent.click(screen.getByRole('button', { name: /^Disciplines:/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    renderMultiSelect({ value: ['disc-1'] });

    const trigger = screen.getByRole('button', { name: /^Disciplines:/ });
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Disciplines options' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Disciplines options' })).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it('respects the disabled state', () => {
    renderMultiSelect({ value: ['disc-1'], disabled: true });

    expect(screen.getByRole('button', { name: /^Disciplines:/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Remove Computer Science' })).toBeNull();
  });

  it('applies aria-invalid and aria-describedby to the trigger', () => {
    render(
      <MultiSelect
        id="test-disciplines"
        label="Disciplines"
        options={sampleOptions}
        value={[]}
        onChange={vi.fn()}
        aria-invalid={true}
        aria-describedby="metadata-disciplines-error"
      />
    );

    const trigger = screen.getByRole('button', { name: /^Disciplines:/ });
    expect(trigger.getAttribute('aria-invalid')).toBe('true');
    expect(trigger.getAttribute('aria-describedby')).toBe('metadata-disciplines-error');
  });
});
