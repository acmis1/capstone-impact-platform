import React from 'react';
import { requireAdmin } from '../../../auth/requireAdmin';
import { canManageStaff } from '../../../auth/permissions';
import { createSupabaseAdminClient } from '../../../lib/supabase/admin';
import { ASSIGNABLE_STAFF_ROLES, readStaffDirectory } from '../../../staff/staffDirectory';
import { isStaffProvisioningEnabled } from '../../../staff/staffProvisioningEnablement';
import { StaffDirectoryTable } from '../../../components/admin-staff/StaffDirectoryTable';
import { StaffInvitationForm } from '../../../components/admin-staff/StaffInvitationForm';
import { StaffTestAccountForm } from '../../../components/admin-staff/StaffTestAccountForm';
import { Badge } from '../../../components/ui/badge';
import { ErrorState } from '../../../components/ui/error-state';
import type {
  StaffDirectoryEntry,
  StaffProvisioningIncident,
} from '../../../staff/staffProvisioningRepository';
import { isVerifiedStagingRuntime } from '../../../security/stagingRuntimeIdentity';

export const dynamic = 'force-dynamic';

/**
 * Staff access management surface.
 *
 * Authorization is enforced here on the server, independently of whether any navigation control
 * is rendered, and again at the `/api/staff/invitations` boundary. Hiding the surface is a
 * usability affordance, never the security boundary.
 */
export default async function StaffAccessPage() {
  const adminContext = await requireAdmin();

  if (!canManageStaff(adminContext.permissions)) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex max-w-3xl flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Staff access</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Review Admin/CMS access and create governed staff invitations.
          </p>
        </header>
        <ErrorState
          title="Access denied"
          description="Your account cannot manage staff access. The directory and provisioning controls are available only to authorized administrators."
          headingLevel="h2"
        />
      </div>
    );
  }

  let staff: StaffDirectoryEntry[] = [];
  let incidents: StaffProvisioningIncident[] = [];
  let directoryFailed = false;
  const provisioningEnabled = isStaffProvisioningEnabled();
  const testAccountAvailable = provisioningEnabled && isVerifiedStagingRuntime();

  try {
    const directory = await readStaffDirectory(createSupabaseAdminClient());
    staff = directory.staff;
    incidents = directory.incidents;
  } catch {
    console.error('[Staff Access Page]: STAFF_DIRECTORY_READ_FAILED');
    directoryFailed = true;
  }

  const activeCount = staff.filter((entry) => entry.status === 'active').length;
  const pendingCount = staff.filter((entry) => entry.status === 'pending_activation').length;
  const needsAttentionCount = incidents.filter(
    (incident) => incident.status === 'compensation_failed',
  ).length;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-3xl">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Staff access</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Review who can use the Admin/CMS, monitor pending setup, and create governed staff
              access when provisioning is available.
            </p>
          </div>
          <Badge variant={provisioningEnabled ? 'success' : 'warning'} className="w-fit">
            {provisioningEnabled ? 'Invitations available' : 'Invitations paused'}
          </Badge>
        </div>

        <dl className="grid overflow-hidden rounded-xl border border-border-structural bg-card shadow-xs sm:grid-cols-2 xl:grid-cols-4">
          <div className="border-b border-border/80 px-5 py-4 sm:border-r xl:border-b-0">
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Staff accounts</dt>
            <dd className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
              {directoryFailed ? '—' : staff.length}
            </dd>
          </div>
          <div className="border-b border-border/80 px-5 py-4 xl:border-b-0 xl:border-r">
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Active</dt>
            <dd className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
              {directoryFailed ? '—' : activeCount}
            </dd>
          </div>
          <div className="border-b border-border/80 px-5 py-4 sm:border-b-0 sm:border-r">
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Awaiting setup</dt>
            <dd className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
              {directoryFailed ? '—' : pendingCount}
            </dd>
          </div>
          <div className="px-5 py-4">
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Needs attention</dt>
            <dd className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
              {directoryFailed ? '—' : needsAttentionCount}
            </dd>
          </div>
        </dl>
      </header>

      {directoryFailed ? (
        <ErrorState
          title="Staff directory unavailable"
          description="The staff directory could not be loaded. Try again shortly."
          headingLevel="h2"
        />
      ) : (
        <StaffDirectoryTable staff={staff} incidents={incidents} />
      )}

      <section aria-labelledby="staff-access-actions-heading" className="flex flex-col gap-4">
        <div className="max-w-3xl">
          <h2 id="staff-access-actions-heading" className="text-lg font-semibold tracking-tight text-foreground">
            Access creation
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Invitations are the normal staff onboarding path. Ready-to-use test accounts appear
            only on verified staging when provisioning is enabled.
          </p>
        </div>
        <div className={testAccountAvailable ? 'grid gap-6 xl:grid-cols-2' : 'max-w-3xl'}>
          <StaffInvitationForm
            assignableRoles={ASSIGNABLE_STAFF_ROLES}
            provisioningEnabled={provisioningEnabled}
          />
          <StaffTestAccountForm available={testAccountAvailable} />
        </div>
      </section>
    </div>
  );
}
