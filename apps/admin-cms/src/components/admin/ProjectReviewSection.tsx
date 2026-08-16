import React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card';
import { LucideIcon } from 'lucide-react';

interface ProjectReviewSectionProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function ProjectReviewSection({
  title,
  description,
  icon: Icon,
  action,
  children,
  className,
}: ProjectReviewSectionProps) {
  return (
    <Card className={`bg-card border-border shadow-xs ${className || ''}`}>
      <CardHeader className="py-3.5 px-4 sm:px-6 border-b border-border flex flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 min-w-0">
          {Icon && <Icon className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />}
          <div>
            <CardTitle className="text-sm sm:text-base font-semibold text-foreground">
              {title}
            </CardTitle>
            {description && (
              <CardDescription className="text-xs text-muted-foreground mt-0.5">
                {description}
              </CardDescription>
            )}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </CardHeader>
      <CardContent className="p-4 sm:p-6">
        {children}
      </CardContent>
    </Card>
  );
}
