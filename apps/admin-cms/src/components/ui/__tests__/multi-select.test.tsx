/** @vitest-environment jsdom */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MultiSelect, MultiSelectOption } from '../multi-select';

const sampleOptions: MultiSelectOption[] = [
  { id: 'disc-1', name: 'Computer Science' },
  { id: 'disc-2', name: 'Software Engineering' },
  { id: 'disc-3', name: 'Data Science' },
  { id: 'disc-4', name: 'Cybersecurity' },
  { id: 'disc-5', name: 'Information Systems' },
];

afterEach(cleanup);

describe('MultiSelect component', () => {
  it('renders with placeholder when no values are selected', () => {
    render(
      <MultiSelect
        id="test-disciplines"
        label="Disciplines"
        options={sampleOptions}
        value={[]}
        onChange={vi.fn()}
      />
    );

    const trigger = screen.getByRole('combobox', { name: /Disciplines, 0 selected/i });
    expect(trigger).toBeTruthy();
    expect(screen.getByText('Select disciplines…')).toBeTruthy();
  });

  it('renders selected chips when initial values are provided', () => {
    render(
      <MultiSelect
        id="test-disciplines"
        label="Disciplines"
        options={sampleOptions}
        value={['disc-1', 'disc-2']}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText('2 disciplines selected')).toBeTruthy();
    expect(screen.getByText('Computer Science')).toBeTruthy();
    expect(screen.getByText('Software Engineering')).toBeTruthy();
  });

  it('opens popup when clicked and shows option list with checkboxes', () => {
    render(
      <MultiSelect
        id="test-disciplines"
        label="Disciplines"
        options={sampleOptions}
        value={['disc-1']}
        onChange={vi.fn()}
      />
    );

    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('listbox', { name: 'Disciplines' })).toBeTruthy();

    const csOption = screen.getByRole('option', { name: /Computer Science/i });
    expect(csOption.getAttribute('aria-selected')).toBe('true');

    const seOption = screen.getByRole('option', { name: /Software Engineering/i });
    expect(seOption.getAttribute('aria-selected')).toBe('false');
  });

  it('calls onChange with updated IDs when an option is selected', () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        id="test-disciplines"
        label="Disciplines"
        options={sampleOptions}
        value={['disc-1']}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole('combobox'));
    const seOption = screen.getByRole('option', { name: /Software Engineering/i });
    fireEvent.click(seOption);

    expect(onChange).toHaveBeenCalledWith(['disc-1', 'disc-2']);
  });

  it('calls onChange with removed ID when a selected option is deselected in popup', () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        id="test-disciplines"
        label="Disciplines"
        options={sampleOptions}
        value={['disc-1', 'disc-2']}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole('combobox'));
    const csOption = screen.getByRole('option', { name: /Computer Science/i });
    fireEvent.click(csOption);

    expect(onChange).toHaveBeenCalledWith(['disc-2']);
  });

  it('removes option via chip remove button without opening popup', () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        id="test-disciplines"
        label="Disciplines"
        options={sampleOptions}
        value={['disc-1', 'disc-2']}
        onChange={onChange}
      />
    );

    const removeBtn = screen.getByRole('button', { name: 'Remove Computer Science' });
    fireEvent.click(removeBtn);

    expect(onChange).toHaveBeenCalledWith(['disc-2']);
    // Popup was not opened
    expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('false');
  });

  it('filters options when typing in the search box', () => {
    render(
      <MultiSelect
        id="test-disciplines"
        label="Disciplines"
        options={sampleOptions}
        value={[]}
        onChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('combobox'));
    const searchInput = screen.getByLabelText(/Search disciplines/i);
    fireEvent.change(searchInput, { target: { value: 'cyber' } });

    expect(screen.getByRole('option', { name: /Cybersecurity/i })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Computer Science/i })).toBeNull();
  });

  it('clears all selections when Clear all is clicked', () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        id="test-disciplines"
        label="Disciplines"
        options={sampleOptions}
        value={['disc-1', 'disc-2']}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole('combobox'));
    const clearBtn = screen.getByRole('button', { name: /Clear all/i });
    fireEvent.click(clearBtn);

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('respects disabled state', () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        id="test-disciplines"
        label="Disciplines"
        options={sampleOptions}
        value={['disc-1']}
        disabled={true}
        onChange={onChange}
      />
    );

    const trigger = screen.getByRole('combobox');
    expect(trigger.hasAttribute('disabled')).toBe(true);

    // Remove button should not be rendered when disabled
    expect(screen.queryByRole('button', { name: 'Remove Computer Science' })).toBeNull();
  });

  it('applies aria-invalid when invalid', () => {
    render(
      <MultiSelect
        id="test-disciplines"
        label="Disciplines"
        options={sampleOptions}
        value={[]}
        onChange={vi.fn()}
        aria-invalid={true}
      />
    );

    const trigger = screen.getByRole('combobox');
    expect(trigger.getAttribute('aria-invalid')).toBe('true');
  });
});
