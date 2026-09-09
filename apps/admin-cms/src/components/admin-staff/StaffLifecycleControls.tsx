'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import type { AdminRole } from '../../auth/authTypes';
import {
  staffLifecycleMessage,
  type StaffLifecycleAction,
  type StaffLifecycleResultCode,
} from '../../staff/staffLifecycle';
import type { StaffDirectoryEntry } from '../../staff/staffProvisioningRepository';
import { Alert } from '../ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { Button } from '../ui/button';

const ROLES: readonly AdminRole[] = ['admin', 'reviewer', 'editor'];
const ROLE_LABELS: Record<AdminRole, string> = {
  admin: 'Administrator',
  reviewer: 'Reviewer',
  editor: 'Editor',
};

type ConfirmedAction = StaffLifecycleAction | null;

function sameRoles(left: readonly AdminRole[], right: readonly AdminRole[]): boolean {
  return left.length === right.length && left.every((role, index) => role === right[index]);
}

function confirmation(action: Exclude<ConfirmedAction, null>, staff: StaffDirectoryEntry) {
  switch (action) {
    case 'replace_roles':
      return {
        title: 'Replace this staff member’s roles?',
        description: `This replaces the complete recognized role set for ${staff.email}. Removed roles stop granting authority immediately.`,
        label: 'Replace roles',
      };
    case 'deactivate':
      return {
        title: 'Deactivate this staff account?',
        description: `This immediately removes all Admin/CMS authority for ${staff.email}. Sign-in cleanup will then be attempted separately. Historical staff and audit records remain.`,
        label: 'Deactivate access',
      };
    case 'reactivate':
      return {
        title: 'Reactivate this staff account?',
        description: `This explicitly restores Admin/CMS authority for ${staff.email} using only the selected roles, then attempts to restore provider sign-in access.`,
        label: 'Reactivate access',
      };
    case 'reconcile':
      return {
        title: 'Retry sign-in access synchronization?',
        description: `This retries only the provider action required by the current authoritative lifecycle state for ${staff.email}. It does not change roles or lifecycle status.`,
        label: 'Retry synchronization',
      };
  }
}

export interface StaffLifecycleControlsProps {
  staff: StaffDirectoryEntry;
  isCurrentUser: boolean;
}

export function StaffLifecycleControls({ staff, isCurrentUser }: StaffLifecycleControlsProps) {
  const router = useRouter();
  const controlId = React.useId().replace(/:/g, '');
  const submissionLocked = React.useRef(false);
  const [roles, setRoles] = React.useState<AdminRole[]>(staff.roles);
  const [action, setAction] = React.useState<ConfirmedAction>(null);
  const [busy, setBusy] = React.useState(false);
  const [outcome, setOutcome] = React.useState<{
    code: StaffLifecycleResultCode;
    message: string;
    accepted: boolean;
  } | null>(null);

  if (isCurrentUser) {
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        Your own access cannot be changed here.
      </p>
    );
  }

  const toggleRole = (role: AdminRole) => {
    setRoles((current) => {
      const next = new Set(current);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return ROLES.filter((candidate) => next.has(candidate));
    });
  };

  const run = async () => {
    if (!action || submissionLocked.current) return;
    submissionLocked.current = true;
    setBusy(true);
    setOutcome(null);
    const body = action === 'replace_roles' || action === 'reactivate'
      ? {
        action,
        targetEmail: staff.email,
        expectedVersion: staff.version,
        roles,
      }
      : { action, targetEmail: staff.email, expectedVersion: staff.version };

    try {
      const response = await fetch('/api/staff/lifecycle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null) as {
        success?: boolean;
        code?: StaffLifecycleResultCode;
        message?: string;
      } | null;
      const code = payload?.code ?? 'LIFECYCLE_FAILED';
      setOutcome({
        code,
        message: payload?.message ?? staffLifecycleMessage(code),
        accepted: payload?.success === true,
      });
      if (
        payload?.success === true
        || code === 'STALE_VERSION'
        || code === 'PROVIDER_RECONCILIATION_REQUIRED'
      ) router.refresh();
    } catch {
      setOutcome({
        code: 'LIFECYCLE_FAILED',
        message: staffLifecycleMessage('LIFECYCLE_FAILED'),
        accepted: false,
      });
    } finally {
      submissionLocked.current = false;
      setBusy(false);
      setAction(null);
    }
  };

  const providerUnresolved = staff.providerSync !== 'synchronized';
  const roleAction = staff.status === 'deactivated' ? 'reactivate' : 'replace_roles';
  const roleActionDisabled = busy
    || providerUnresolved
    || roles.length === 0
    || (roleAction === 'replace_roles' && sameRoles(roles, staff.roles));
  const copy = action ? confirmation(action, staff) : null;
  const warning = outcome?.code.includes('PROVIDER')
    || outcome?.code === 'STALE_VERSION'
    || outcome?.code === 'IN_PROGRESS';

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {providerUnresolved ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setAction('reconcile')}
        >
          Retry sign-in sync
        </Button>
      ) : (
        <>
          <fieldset className="flex flex-col gap-2 border-0 p-0" disabled={busy}>
            <legend className="text-xs font-semibold text-muted-foreground">Access roles</legend>
            <div className="flex flex-wrap gap-x-3 gap-y-2">
              {ROLES.map((role) => (
                <label key={role} htmlFor={`${controlId}-${role}`} className="flex items-center gap-1.5 text-xs">
                  <input
                    id={`${controlId}-${role}`}
                    type="checkbox"
                    checked={roles.includes(role)}
                    onChange={() => toggleRole(role)}
                    className="h-4 w-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  {ROLE_LABELS[role]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={roleAction === 'reactivate' ? 'default' : 'outline'}
              size="sm"
              disabled={roleActionDisabled}
              onClick={() => setAction(roleAction)}
            >
              {roleAction === 'reactivate' ? 'Reactivate' : 'Replace roles'}
            </Button>
            {staff.status !== 'deactivated' && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => setAction('deactivate')}
              >
                Deactivate
              </Button>
            )}
          </div>
        </>
      )}

      {outcome && (
        <div aria-live="polite" role="status">
          <Alert
            variant={outcome.accepted ? (warning ? 'warning' : 'success') : (warning ? 'warning' : 'destructive')}
            title={outcome.accepted ? 'Staff access recorded' : 'Staff access not changed'}
            description={outcome.message}
          />
        </div>
      )}

      <AlertDialog open={action !== null} onOpenChange={(open) => { if (!open && !busy) setAction(null); }}>
        {copy && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.title}</AlertDialogTitle>
              <AlertDialogDescription>{copy.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant={action === 'deactivate' ? 'destructive' : 'default'}
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault();
                  void run();
                }}
              >
                {busy ? 'Recording…' : copy.label}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  );
}
