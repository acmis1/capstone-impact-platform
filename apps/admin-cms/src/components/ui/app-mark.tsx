import * as React from 'react';
import { cn } from '../../lib/utils';

export interface AppMarkProps extends React.ComponentProps<'svg'> {
  size?: 'sm' | 'md' | 'lg';
}

export function AppMark({ className, size = 'md', ...props }: AppMarkProps) {
  const dimensionClass =
    size === 'sm'
      ? 'h-6 w-6'
      : size === 'lg'
        ? 'h-10 w-10'
        : 'h-8 w-8';

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={cn('shrink-0 rounded-md', dimensionClass, className)}
      {...props}
    >
      {/* Brand Background */}
      <rect width="32" height="32" rx="6" className="fill-primary" />
      {/* Neutral "CI" Capstone Impact Monogram */}
      <text
        x="16"
        y="21.5"
        textAnchor="middle"
        fill="#ffffff"
        fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        fontWeight="800"
        fontSize="14"
        letterSpacing="-0.5"
      >
        CI
      </text>
    </svg>
  );
}
