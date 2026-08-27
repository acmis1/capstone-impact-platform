'use client';

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
  placeholder?: string;
  disabled?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  className?: string;
}

export function MultiSelect({
  id,
  label,
  options,
  value = [],
  onChange,
  placeholder,
  disabled = false,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  className,
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  const selectedOptions = React.useMemo(() => {
    return value
      .map((id) => options.find((opt) => opt.id === id))
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
      onChange(value.filter((id) => id !== optionId));
    } else {
      onChange([...value, optionId]);
    }
  };

  const handleRemove = (optionId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    if (disabled) return;
    onChange(value.filter((id) => id !== optionId));
  };

  const handleClearAll = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (disabled) return;
    onChange([]);
  };

  const displayPlaceholder = placeholder || `Select ${label.toLowerCase()}…`;

  return (
    <div className={cn('flex flex-col gap-2 w-full', className)}>
      <RadixPopover.Root open={open} onOpenChange={setOpen}>
        <RadixPopover.Trigger asChild>
          <button
            ref={triggerRef}
            id={id}
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls={`${id}-listbox`}
            aria-invalid={ariaInvalid}
            aria-describedby={ariaDescribedBy}
            aria-label={`${label}, ${value.length} selected`}
            disabled={disabled}
            className={cn(
              'flex min-h-[40px] w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-2xs transition-colors',
              'hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
              'disabled:cursor-not-allowed disabled:opacity-50',
              ariaInvalid && 'border-destructive focus-visible:ring-destructive'
            )}
          >
            <span
              className={cn(
                'truncate text-left',
                value.length === 0 ? 'text-muted-foreground' : 'text-foreground font-medium'
              )}
            >
              {value.length === 0
                ? displayPlaceholder
                : `${value.length} ${label.toLowerCase()} selected`}
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
            id={`${id}-listbox`}
            role="listbox"
            aria-label={label}
            aria-multiselectable="true"
            sideOffset={4}
            className={cn(
              'z-50 w-[var(--radix-popover-trigger-width)] min-w-[16rem] max-w-[calc(100vw-2rem)]',
              'overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md',
              'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
              'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
              'data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2'
            )}
          >
            {/* Search Input Filter if there are 4 or more options */}
            {options.length >= 4 && (
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={`Search ${label.toLowerCase()}…`}
                  aria-label={`Search ${label.toLowerCase()}`}
                  className="h-7 w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                    className="text-muted-foreground hover:text-foreground rounded p-0.5"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
              </div>
            )}

            {/* Options List */}
            <div className="max-h-60 overflow-y-auto p-1.5 flex flex-col gap-0.5">
              {filteredOptions.length === 0 ? (
                <div className="p-3 text-center text-xs text-muted-foreground">
                  No matching {label.toLowerCase()} found.
                </div>
              ) : (
                filteredOptions.map((option) => {
                  const isSelected = value.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => handleToggle(option.id)}
                      className={cn(
                        'flex min-h-[38px] w-full cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
                        'hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none',
                        isSelected && 'bg-accent/40 font-medium text-foreground'
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                          isSelected
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-input bg-background'
                        )}
                        aria-hidden="true"
                      >
                        {isSelected && <Check className="h-3 w-3 stroke-[3]" />}
                      </span>
                      <span className="truncate flex-1">{option.name}</span>
                    </button>
                  );
                })
              )}
            </div>

            {/* Footer Summary / Clear Action */}
            <div className="flex items-center justify-between border-t border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              <span>
                {value.length} of {options.length} selected
              </span>
              {value.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearAll}
                  className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded px-1"
                >
                  Clear all
                </button>
              )}
            </div>
          </RadixPopover.Content>
        </RadixPopover.Portal>
      </RadixPopover.Root>

      {/* Selected Items Chips Display */}
      {selectedOptions.length > 0 && (
        <div
          className="flex flex-wrap gap-1.5 pt-1"
          aria-label={`Selected ${label.toLowerCase()}`}
        >
          {selectedOptions.map((opt) => (
            <span
              key={opt.id}
              className="inline-flex items-center gap-1 rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-foreground border border-border"
            >
              <span className="truncate max-w-[200px]" title={opt.name}>
                {opt.name}
              </span>
              {!disabled && (
                <button
                  type="button"
                  onClick={(e) => handleRemove(opt.id, e)}
                  aria-label={`Remove ${opt.name}`}
                  className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-full p-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
