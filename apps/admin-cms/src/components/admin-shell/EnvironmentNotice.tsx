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
        'bg-muted/60 border-b border-border px-4 py-2 text-xs text-muted-foreground flex items-center gap-2',
        className
      )}
      {...props}
    >
      <ShieldAlert className="h-3.5 w-3.5 text-warning shrink-0" aria-hidden="true" />
      <span>
        <strong className="font-semibold text-foreground">Test environment:</strong> Work here uses staging data and does not update the public showcase website.
      </span>
    </div>
  );
}
