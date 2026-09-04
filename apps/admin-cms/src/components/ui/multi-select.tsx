'use client';

/* eslint-disable jsx-a11y/role-supports-aria-props --
   aria-invalid is a global ARIA property and is therefore valid on the trigger button; this rule
   still validates it against the older per-role support table. */

import * as React from 'react';
import { Popover as RadixPopover } from 'radix-ui';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface MultiSelectOption {
  id: string;
  name: string;
}

export interface MultiSelectProps {
  id: string;
  label: string;
  options: MultiSelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  className?: string;
}

/**
 * Multi-value picker built as a Popover *dialog* holding a real checkbox group.
 *
 * The panel deliberately does not claim `role="listbox"`: it also contains a search field, a
 * clear-search control and a footer action, none of which are valid children of a listbox. Native
 * `input[type=checkbox]` elements carry the selection semantics instead, so screen readers get
 * genuine checked state and keyboards get Tab to move plus Space to toggle - with no roving
 * tabindex or arrow-key behaviour claimed that is not implemented, and no modifier key required to
 * select more than one value. Escape closes the panel and Radix restores focus to the trigger.
 *
 * The value contract is unchanged: `value: string[]` of option ids in, `onChange(string[])` out.
 */
export function MultiSelect({
  id,
  label,
  options,
  value = [],
  onChange,
  disabled = false,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  className,
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');

  const panelId = `${id}-panel`;
  const searchId = `${id}-search`;
  const lowerLabel = label.toLowerCase();

  const selectedOptions = React.useMemo(() => {
    return value
      .map((selectedId) => options.find((opt) => opt.id === selectedId))
      .filter((opt): opt is MultiSelectOption => opt !== undefined);
  }, [value, options]);

  const filteredOptions = React.useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return options;
    return options.filter((opt) => opt.name.toLowerCase().includes(query));
  }, [options, searchQuery]);

  const handleToggle = (optionId: string) => {
    if (disabled) return;
    if (value.includes(optionId)) {
      onChange(value.filter((selectedId) => selectedId !== optionId));
    } else {
      onChange([...value, optionId]);
    }
  };

  const handleRemove = (optionId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    if (disabled) return;
    onChange(value.filter((selectedId) => selectedId !== optionId));
  };

  const handleClearAll = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (disabled) return;
    onChange([]);
  };

  // The visible summary doubles as the state announcement, so the accessible name always states
  // how many values are selected rather than only implying it through styling.
  const summary = value.length === 0 ? 'None selected' : `${value.length} selected`;

  return (
    <div className={cn('flex w-full flex-col gap-2', className)}>
      <RadixPopover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSearchQuery('');
        }}
      >
        <RadixPopover.Trigger asChild>
          <button
            id={id}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            aria-invalid={ariaInvalid}
            aria-describedby={ariaDescribedBy}
            aria-label={`${label}: ${summary}`}
            disabled={disabled}
            className={cn(
              'flex min-h-[40px] w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-2xs transition-colors',
              'hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
              'disabled:cursor-not-allowed disabled:opacity-50',
              ariaInvalid && 'border-destructive focus-visible:ring-destructive'
            )}
          >
            <span
              className={cn(
                'truncate text-left',
                value.length === 0 ? 'text-muted-foreground' : 'font-medium text-foreground'
              )}
            >
              {summary}
            </span>
            <ChevronDown
              className={cn(
                'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
                open && 'rotate-180 text-foreground'
              )}
              aria-hidden="true"
            />
          </button>
        </RadixPopover.Trigger>

        <RadixPopover.Portal>
          <RadixPopover.Content
            id={panelId}
            role="dialog"
            aria-label={`${label} options`}
            sideOffset={4}
            collisionPadding={16}
            className={cn(
              'z-50 w-[var(--radix-popover-trigger-width)] min-w-[16rem] max-w-[calc(100vw-2rem)]',
              // Never taller than the space Radix reports, so the panel cannot spill out of the
              // viewport on short screens; the option list absorbs the difference by scrolling.
              'flex flex-col max-h-[var(--radix-popover-content-available-height)]',
              'overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md',
              'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
              'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
              'data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2'
            )}
          >
            {/* Search filter, kept outside the option group so that group exposes options only. */}
            {options.length >= 4 && (
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <label htmlFor={searchId} className="sr-only">
                  Search {lowerLabel}
                </label>
                <input
                  id={searchId}
                  type="text"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={`Search ${lowerLabel}…`}
                  className="h-7 w-full rounded-sm bg-transparent px-1.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
              </div>
            )}

            <p role="status" className="sr-only">
              {filteredOptions.length} of {options.length} {lowerLabel} shown
            </p>

            <div
              role="group"
              aria-label={label}
              className="flex min-h-0 max-h-60 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5"
            >
              {filteredOptions.length === 0 ? (
                <p className="p-3 text-center text-xs text-muted-foreground">
                  No matching {lowerLabel} found.
                </p>
              ) : (
                filteredOptions.map((option) => {
                  const isSelected = value.includes(option.id);
                  return (
                    <label
                      key={option.id}
                      className={cn(
                        'flex min-h-[38px] w-full cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
                        'hover:bg-accent hover:text-accent-foreground',
                        isSelected && 'bg-accent/40 font-medium text-foreground'
                      )}
                    >
                      <input
                        type="checkbox"
                        className="peer sr-only"
                        checked={isSelected}
                        disabled={disabled}
                        onChange={() => handleToggle(option.id)}
                      />
                      <span
                        aria-hidden="true"
                        className={cn(
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                          'peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1',
                          isSelected
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-input bg-background'
                        )}
                      >
                        {isSelected && <Check className="h-3 w-3 stroke-[3]" />}
                      </span>
                      <span className="flex-1 truncate">{option.name}</span>
                    </label>
                  );
                })
              )}
            </div>

            <div className="flex shrink-0 items-center justify-between border-t border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              <span>
                {value.length} of {options.length} selected
              </span>
              {value.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearAll}
                  className="rounded px-1 font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  Clear all
                </button>
              )}
            </div>
          </RadixPopover.Content>
        </RadixPopover.Portal>
      </RadixPopover.Root>

      {selectedOptions.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 pt-1" aria-label={`Selected ${lowerLabel}`}>
          {selectedOptions.map((opt) => (
            <li
              key={opt.id}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-medium text-foreground"
            >
              <span className="max-w-[200px] truncate" title={opt.name}>
                {opt.name}
              </span>
              {!disabled && (
                <button
                  type="button"
                  onClick={(event) => handleRemove(opt.id, event)}
                  aria-label={`Remove ${opt.name}`}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
