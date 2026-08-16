import React from 'react';
import { requireAdmin } from '../../../auth/requireAdmin';
import { canManageStaff } from '../../../auth/permissions';
import { createSupabaseAdminClient } from '../../../lib/supabase/admin';
import { ASSIGNABLE_STAFF_ROLES, readStaffDirectory } from '../../../staff/staffDirectory';
import { isStaffProvisioningEnabled } from '../../../staff/staffProvisioningEnablement';
import { StaffDirectoryTable } from '../../../components/admin-staff/StaffDirectoryTable';
import { StaffInvitationForm } from '../../../components/admin-staff/StaffInvitationForm';
import { StaffTestAccountForm } from '../../../components/admin-staff/StaffTestAccountForm';
import { Alert } from '../../../components/ui/alert';
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
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">Staff access</h1>
        <Alert
          variant="destructive"
          title="Access denied"
          description="You do not have permission to manage staff access."
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

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Staff access</h1>
        <p className="text-sm text-muted-foreground">
          Invite Admin/CMS staff and review who currently has access.
        </p>
      </header>

      <StaffInvitationForm
        assignableRoles={ASSIGNABLE_STAFF_ROLES}
        provisioningEnabled={provisioningEnabled}
      />

      <StaffTestAccountForm available={testAccountAvailable} />

      {directoryFailed ? (
        <ErrorState
          title="Staff directory unavailable"
          description="The staff directory could not be loaded. Try again shortly."
        />
      ) : (
        <StaffDirectoryTable staff={staff} incidents={incidents} />
      )}
    </div>
  );
}
