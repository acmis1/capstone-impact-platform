import React from 'react';
import {
  CheckCircle2,
  CircleStop,
  Clock3,
  RotateCcw,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardDescription, CardHeader } from '../ui/card';
import { EmptyState } from '../ui/empty-state';
import type { AdminRole } from '../../auth/authTypes';
import type {
  StaffDirectoryEntry,
  StaffProvisioningIncident,
} from '../../staff/staffProvisioningRepository';

const ROLE_LABELS: Record<AdminRole, string> = {
  admin: 'Administrator',
  reviewer: 'Reviewer',
  editor: 'Editor',
};

function formatTimestamp(value: string | null): { dateTime: string; label: string } | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return {
    dateTime: parsed.toISOString(),
    label: `${new Intl.DateTimeFormat('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    }).format(parsed)} UTC`,
  };
}

function StaffTimestamp({ value }: { value: string | null }) {
  const timestamp = formatTimestamp(value);
  if (!timestamp) return <span aria-label="Not available">—</span>;
  return <time dateTime={timestamp.dateTime}>{timestamp.label}</time>;
}

function RoleBadges({ roles }: { roles: AdminRole[] }) {
  if (roles.length === 0) {
    return <span className="text-sm text-muted-foreground">No recognized role</span>;
  }

  return (
    <span className="flex flex-wrap gap-1.5">
      {roles.map((role) => (
        <Badge key={role} variant={role === 'admin' ? 'primary' : 'neutral'}>
          {ROLE_LABELS[role]}
        </Badge>
      ))}
    </span>
  );
}

function AccountStatus({ status }: { status: StaffDirectoryEntry['status'] }) {
  return status === 'active' ? (
    <Badge variant="success" className="w-fit">
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
      Active
    </Badge>
  ) : (
    <Badge variant="warning" className="w-fit">
      <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
      Awaiting account setup
    </Badge>
  );
}

function IncidentOutcome({ status }: { status: StaffProvisioningIncident['status'] }) {
  if (status === 'compensating') {
    return (
      <Badge variant="warning" className="w-fit">
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        Cleanup in progress
      </Badge>
    );
  }
  if (status === 'compensation_failed') {
    return (
      <Badge variant="destructive" className="w-fit">
        <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
        Needs attention
      </Badge>
    );
  }
  return (
    <Badge variant="neutral" className="w-fit">
      <CircleStop className="h-3.5 w-3.5" aria-hidden="true" />
      Stopped safely
    </Badge>
  );
}

function incidentExplanation(status: StaffProvisioningIncident['status']): string {
  if (status === 'compensating') {
    return 'Cleanup is still running. Access was not granted.';
  }
  if (status === 'compensation_failed') {
    return 'Automatic cleanup could not finish. Administrator attention is required.';
  }
  return 'The attempt stopped before access was granted. No cleanup action is pending.';
}

export interface StaffDirectoryTableProps {
  staff: StaffDirectoryEntry[];
  incidents: StaffProvisioningIncident[];
}

/**
 * Bounded staff directory.
 *
 * Deliberately renders no internal Auth UUIDs, no staff profile identifiers, no invitation
 * secrets and no provider detail. Desktop tables and narrow-screen lists share the same bounded
 * role, status and timestamp presenters so every safe field retains the same meaning.
 */
export function StaffDirectoryTable({ staff, incidents }: StaffDirectoryTableProps) {
  return (
    <div className="flex flex-col gap-6">
      <Card role="region" aria-labelledby="staff-directory-heading" className="overflow-hidden border-border-structural">
        <CardHeader className="border-b border-border/80">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2
                id="staff-directory-heading"
                data-slot="card-title"
                className="text-base font-semibold leading-tight tracking-tight text-foreground"
              >
                Staff directory
              </h2>
              <CardDescription className="mt-1 max-w-3xl">
                People who can sign in to the Admin/CMS and invitations awaiting account setup.
              </CardDescription>
            </div>
            <Badge variant="neutral" className="w-fit">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              {staff.length} {staff.length === 1 ? 'account' : 'accounts'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0 sm:p-0">
          {staff.length === 0 ? (
            <EmptyState
              className="m-5 min-h-[220px] sm:m-6"
              icon={Users}
              title="No staff accounts"
              description="No Admin/CMS staff accounts exist yet."
            />
          ) : (
            <>
              <div className="hidden xl:block">
                <table className="w-full table-fixed border-collapse text-sm">
                  <caption className="sr-only">Admin/CMS staff accounts and their assigned roles</caption>
                  <colgroup>
                    <col className="w-[21%]" />
                    <col className="w-[27%]" />
                    <col className="w-[20%]" />
                    <col className="w-[19%]" />
                    <col className="w-[13%]" />
                  </colgroup>
                  <thead className="bg-muted/55 text-foreground-subtle">
                    <tr className="border-b border-border text-left">
                      <th scope="col" className="px-5 py-3 font-semibold">Name</th>
                      <th scope="col" className="px-5 py-3 font-semibold">Email</th>
                      <th scope="col" className="px-5 py-3 font-semibold">Roles</th>
                      <th scope="col" className="px-5 py-3 font-semibold">Status</th>
                      <th scope="col" className="px-5 py-3 font-semibold">Requested</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staff.map((entry) => (
                      <tr key={entry.email} className="border-b border-border/70 last:border-b-0">
                        <th
                          scope="row"
                          className="px-5 py-4 text-left font-semibold leading-relaxed text-foreground [overflow-wrap:anywhere]"
                        >
                          {entry.fullName || '—'}
                        </th>
                        <td className="px-5 py-4 align-top leading-relaxed text-foreground-subtle [overflow-wrap:anywhere]">
                          {entry.email}
                        </td>
                        <td className="px-5 py-4 align-top"><RoleBadges roles={entry.roles} /></td>
                        <td className="px-5 py-4 align-top"><AccountStatus status={entry.status} /></td>
                        <td className="px-5 py-4 align-top text-xs leading-relaxed text-muted-foreground">
                          <StaffTimestamp value={entry.requestedAt} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul aria-label="Admin/CMS staff accounts" className="divide-y divide-border/70 xl:hidden">
                {staff.map((entry) => (
                  <li key={entry.email} className="p-5 sm:p-6">
                    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <p className="min-w-0 font-semibold leading-relaxed text-foreground [overflow-wrap:anywhere]">
                        {entry.fullName || '—'}
                      </p>
                      <AccountStatus status={entry.status} />
                    </div>
                    <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                      <div className="min-w-0 sm:col-span-2">
                        <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Email</dt>
                        <dd className="mt-1 text-sm text-foreground-subtle [overflow-wrap:anywhere]">{entry.email}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Roles</dt>
                        <dd className="mt-1.5"><RoleBadges roles={entry.roles} /></dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Invited / requested</dt>
                        <dd className="mt-1 text-sm text-foreground-subtle"><StaffTimestamp value={entry.requestedAt} /></dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {incidents.length > 0 && (
        <Card role="region" aria-labelledby="staff-incidents-heading" className="overflow-hidden border-warning/30">
          <CardHeader className="border-b border-warning/20 bg-warning/[0.04]">
            <h2
              id="staff-incidents-heading"
              data-slot="card-title"
              className="text-base font-semibold leading-tight tracking-tight text-foreground"
            >
              Invitations that did not complete
            </h2>
            <CardDescription className="max-w-3xl">
              These attempts did not create usable access. Cleanup and attention states remain
              distinct so administrators can identify what, if anything, still needs follow-up.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 sm:p-0">
            <div className="hidden xl:block">
              <table className="w-full table-fixed border-collapse text-sm">
                <caption className="sr-only">Staff invitations that did not complete</caption>
                <colgroup>
                  <col className="w-[18%]" />
                  <col className="w-[23%]" />
                  <col className="w-[16%]" />
                  <col className="w-[30%]" />
                  <col className="w-[13%]" />
                </colgroup>
                <thead className="bg-muted/55 text-foreground-subtle">
                  <tr className="border-b border-border text-left">
                    <th scope="col" className="px-5 py-3 font-semibold">Name</th>
                    <th scope="col" className="px-5 py-3 font-semibold">Email</th>
                    <th scope="col" className="px-5 py-3 font-semibold">Requested roles</th>
                    <th scope="col" className="px-5 py-3 font-semibold">Outcome</th>
                    <th scope="col" className="px-5 py-3 font-semibold">Requested</th>
                  </tr>
                </thead>
                <tbody>
                  {incidents.map((incident, index) => (
                    <tr key={`${incident.email}-${index}`} className="border-b border-border/70 last:border-b-0">
                      <th scope="row" className="px-5 py-4 text-left font-semibold leading-relaxed [overflow-wrap:anywhere]">
                        {incident.fullName || '—'}
                      </th>
                      <td className="px-5 py-4 align-top leading-relaxed text-foreground-subtle [overflow-wrap:anywhere]">
                        {incident.email}
                      </td>
                      <td className="px-5 py-4 align-top"><RoleBadges roles={incident.roles} /></td>
                      <td className="px-5 py-4 align-top">
                        <IncidentOutcome status={incident.status} />
                        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                          {incidentExplanation(incident.status)}
                        </p>
                      </td>
                      <td className="px-5 py-4 align-top text-xs leading-relaxed text-muted-foreground">
                        <StaffTimestamp value={incident.requestedAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul aria-label="Staff invitations that did not complete" className="divide-y divide-border/70 xl:hidden">
              {incidents.map((incident, index) => (
                <li key={`${incident.email}-${index}`} className="p-5 sm:p-6">
                  <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <p className="min-w-0 font-semibold leading-relaxed [overflow-wrap:anywhere]">
                      {incident.fullName || '—'}
                    </p>
                    <IncidentOutcome status={incident.status} />
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {incidentExplanation(incident.status)}
                  </p>
                  <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Email</dt>
                      <dd className="mt-1 text-sm text-foreground-subtle [overflow-wrap:anywhere]">{incident.email}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Requested roles</dt>
                      <dd className="mt-1.5"><RoleBadges roles={incident.roles} /></dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Requested</dt>
                      <dd className="mt-1 text-sm text-foreground-subtle"><StaffTimestamp value={incident.requestedAt} /></dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
