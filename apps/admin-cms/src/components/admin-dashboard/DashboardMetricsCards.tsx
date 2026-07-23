import * as React from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { ProjectDashboardMetrics } from '../../domain/projectQuery';
import { FolderKanban, CheckCircle2, Clock, Archive } from 'lucide-react';

export interface DashboardMetricsCardsProps {
  metrics: ProjectDashboardMetrics;
}

export function DashboardMetricsCards({ metrics }: DashboardMetricsCardsProps) {
  const cards = [
    {
      title: 'Total Projects',
      value: metrics.totalProjects,
      description: 'Active project records',
      icon: FolderKanban,
      colorClass: 'text-primary bg-primary/10',
    },
    {
      title: 'Public Eligible',
      value: metrics.publicEligible,
      description: 'Approved or published',
      icon: CheckCircle2,
      colorClass: 'text-success bg-success/10',
    },
    {
      title: 'In Review',
      value: metrics.inReview,
      description: 'Pending review or changes',
      icon: Clock,
      colorClass: 'text-warning bg-warning/10',
    },
    {
      title: 'Archived',
      value: metrics.archived,
      description: 'Historical project records',
      icon: Archive,
      colorClass: 'text-muted-foreground bg-muted',
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <Card key={card.title} className="shadow-xs">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {card.title}
              </CardTitle>
              <div className={`p-2 rounded-md ${card.colorClass}`}>
                <Icon className="h-4 w-4" aria-hidden="true" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-foreground">
                {card.value.toLocaleString()}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {card.description}
              </p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
