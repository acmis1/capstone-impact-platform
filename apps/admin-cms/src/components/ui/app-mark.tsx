import * as React from 'react';
import { cn } from '../../lib/utils';
import {
  APP_MARK_CORNER_RADIUS,
  APP_MARK_PATHS,
  APP_MARK_VIEW_BOX,
} from './app-mark-geometry';

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
      viewBox={APP_MARK_VIEW_BOX}
      fill="none"
      className={cn('shrink-0 rounded-md', dimensionClass, className)}
      {...props}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx={APP_MARK_CORNER_RADIUS} className="fill-primary" />
      {APP_MARK_PATHS.map((path) => (
        <path key={path} d={path} className="fill-primary-foreground" />
      ))}
    </svg>
  );
}
