import React from 'react';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { EmptyState } from '../ui/empty-state';
import type {
  StaffDirectoryEntry,
  StaffProvisioningIncident,
} from '../../staff/staffProvisioningRepository';

const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrator',
  reviewer: 'Reviewer',
  editor: 'Editor',
};

function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toISOString().replace('T', ' ').slice(0, 16);
}

export interface StaffDirectoryTableProps {
  staff: StaffDirectoryEntry[];
  incidents: StaffProvisioningIncident[];
}

/**
 * Bounded staff directory.
 *
 * Deliberately renders no internal Auth UUIDs, no staff profile identifiers, no invitation
 * secrets and no provider detail — status is communicated with both a text label and a badge
 * rather than colour alone.
 */
export function StaffDirectoryTable({ staff, incidents }: StaffDirectoryTableProps) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Staff access</CardTitle>
          <CardDescription>
            Accounts that can sign in to the Admin/CMS, and invitations still awaiting account setup.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {staff.length === 0 ? (
            <EmptyState title="No staff accounts" description="No Admin/CMS staff accounts exist yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] border-collapse text-sm">
                <caption className="sr-only">Admin/CMS staff accounts and their assigned roles</caption>
                <thead>
                  <tr className="border-b border-border text-left">
                    <th scope="col" className="px-3 py-2 font-medium">Name</th>
                    <th scope="col" className="px-3 py-2 font-medium">Email</th>
                    <th scope="col" className="px-3 py-2 font-medium">Roles</th>
                    <th scope="col" className="px-3 py-2 font-medium">Status</th>
                    <th scope="col" className="px-3 py-2 font-medium">Invited</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((entry) => (
                    <tr key={entry.email} className="border-b border-border/60">
                      <td className="px-3 py-2">{entry.fullName || '—'}</td>
                      <td className="px-3 py-2">{entry.email}</td>
                      <td className="px-3 py-2">
                        {entry.roles.length === 0
                          ? 'No recognized role'
                          : entry.roles.map((role) => ROLE_LABELS[role] ?? role).join(', ')}
                      </td>
                      <td className="px-3 py-2">
                        {entry.status === 'active' ? (
                          <Badge variant="success">Active</Badge>
                        ) : (
                          <Badge variant="warning">Awaiting account setup</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2">{formatTimestamp(entry.requestedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {incidents.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Incomplete provisioning attempts</CardTitle>
            <CardDescription>
              Cleanup in progress remains visible here. Attempts marked as needing attention
              stopped before their rollback could complete.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] border-collapse text-sm">
                <caption className="sr-only">Staff provisioning attempts that did not complete</caption>
                <thead>
                  <tr className="border-b border-border text-left">
                    <th scope="col" className="px-3 py-2 font-medium">Name</th>
                    <th scope="col" className="px-3 py-2 font-medium">Email</th>
                    <th scope="col" className="px-3 py-2 font-medium">Requested roles</th>
                    <th scope="col" className="px-3 py-2 font-medium">Outcome</th>
                    <th scope="col" className="px-3 py-2 font-medium">Requested</th>
                  </tr>
                </thead>
                <tbody>
                  {incidents.map((incident, index) => (
                    <tr key={`${incident.email}-${index}`} className="border-b border-border/60">
                      <td className="px-3 py-2">{incident.fullName || '—'}</td>
                      <td className="px-3 py-2">{incident.email}</td>
                      <td className="px-3 py-2">
                        {incident.roles.map((role) => ROLE_LABELS[role] ?? role).join(', ') || '—'}
                      </td>
                      <td className="px-3 py-2">
                        {incident.status === 'compensating' ? (
                          <Badge variant="warning">Cleanup in progress</Badge>
                        ) : incident.status === 'compensation_failed' ? (
                          <Badge variant="destructive">Needs attention</Badge>
                        ) : (
                          <Badge variant="neutral">Stopped safely</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2">{formatTimestamp(incident.requestedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
