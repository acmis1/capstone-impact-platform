import * as React from 'react';
import { ShieldAlert } from 'lucide-react';
import { cn } from '../../lib/utils';

export type EnvironmentNoticeProps = React.ComponentProps<'div'>;

export function EnvironmentNotice({ className, ...props }: EnvironmentNoticeProps) {
  return (
    <div
      role="region"
      aria-label="Environment notice"
      className={cn(
        'bg-warning/8 border-b border-warning/20 px-4 lg:px-6 py-2 text-xs text-foreground/90 flex items-center gap-2',
        className
      )}
      {...props}
    >
      <ShieldAlert className="h-4 w-4 text-warning shrink-0" aria-hidden="true" />
      <span>
        <strong className="font-semibold text-foreground">Test environment:</strong> Work here uses staging data and does not update the public showcase website.
      </span>
    </div>
  );
}
