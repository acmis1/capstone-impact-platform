'use client';

import React from 'react';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import type { AdminRole } from '../../auth/authTypes';
import { staffProvisioningMessage, type StaffProvisioningResultCode } from '../../staff/staffProvisioning';
import {
  INITIAL_STAFF_INVITATION_FORM_STATE,
  applyStaffInvitationOutcome,
  canSubmitStaffInvitation,
  staffInvitationAlertVariant,
  toggleStaffRole,
  type StaffInvitationFormState,
} from './staffInvitationFormState';

const ROLE_LABELS: Record<AdminRole, string> = {
  admin: 'Administrator',
  reviewer: 'Reviewer',
  editor: 'Editor',
};

const ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  admin: 'Full project authority, including publication, archiving and staff management.',
  reviewer: 'Can read projects and complete review decisions.',
  editor: 'Can read and edit project metadata.',
};

export interface StaffInvitationFormProps {
  assignableRoles: readonly AdminRole[];
  provisioningEnabled: boolean;
}

/**
 * Invitation request form for the staff-access management surface.
 *
 * The browser sends only the target name, email and selected roles. It never sends — and could
 * not usefully forge — the acting administrator, any Auth identity, authority, permissions or
 * provisioning status: the server derives all of those from the authenticated session.
 */
export function StaffInvitationForm({ assignableRoles, provisioningEnabled }: StaffInvitationFormProps) {
  const [state, setState] = React.useState<StaffInvitationFormState>(INITIAL_STAFF_INVITATION_FORM_STATE);
  const submittable = provisioningEnabled && canSubmitStaffInvitation(state);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!submittable) return;

    setState((current) => ({ ...current, phase: 'submitting', resultCode: null, message: null }));

    let outcome: { code: StaffProvisioningResultCode; message: string };
    try {
      const response = await fetch('/api/staff/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: state.fullName, email: state.email, roles: state.roles }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { code?: string; message?: string }
        | null;
      const code = (payload?.code ?? 'PROVISIONING_FAILED') as StaffProvisioningResultCode;
      outcome = { code, message: payload?.message ?? staffProvisioningMessage(code) };
    } catch {
      outcome = {
        code: 'PROVISIONING_FAILED',
        message: staffProvisioningMessage('PROVISIONING_FAILED'),
      };
    }

    setState((current) => applyStaffInvitationOutcome(current, outcome));
  };

  const variant = staffInvitationAlertVariant(state.resultCode);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite a staff member</CardTitle>
        <CardDescription>
          The invited person sets their own password. No password is ever created, shown or sent by
          an administrator. Access begins only after they complete account setup.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!provisioningEnabled && (
          <Alert
            variant="warning"
            className="mb-4"
            title="Provisioning is not enabled"
            description={staffProvisioningMessage('PROVISIONING_DISABLED')}
          />
        )}

        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="staff-full-name" isRequired>
              Full name
            </Label>
            <Input
              id="staff-full-name"
              name="fullName"
              autoComplete="off"
              maxLength={200}
              value={state.fullName}
              disabled={!provisioningEnabled || state.phase === 'submitting'}
              onChange={(event) =>
                setState((current) => ({ ...current, fullName: event.target.value }))
              }
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="staff-email" isRequired>
              Email address
            </Label>
            <Input
              id="staff-email"
              name="email"
              type="email"
              autoComplete="off"
              maxLength={254}
              value={state.email}
              disabled={!provisioningEnabled || state.phase === 'submitting'}
              onChange={(event) => setState((current) => ({ ...current, email: event.target.value }))}
            />
          </div>

          <fieldset className="flex flex-col gap-2 border-0 p-0">
            <legend className="text-sm font-medium leading-none">
              Roles
              <span className="ml-0.5 text-destructive" aria-hidden="true">*</span>
              <span className="sr-only"> (required)</span>
            </legend>
            {assignableRoles.map((role) => (
              <div key={role} className="flex items-start gap-2">
                <input
                  id={`staff-role-${role}`}
                  name="roles"
                  type="checkbox"
                  value={role}
                  className="mt-1 h-4 w-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  checked={state.roles.includes(role)}
                  disabled={!provisioningEnabled || state.phase === 'submitting'}
                  aria-describedby={`staff-role-${role}-description`}
                  onChange={() =>
                    setState((current) => ({ ...current, roles: toggleStaffRole(current.roles, role) }))
                  }
                />
                <div className="flex flex-col">
                  <Label htmlFor={`staff-role-${role}`}>{ROLE_LABELS[role]}</Label>
                  <span id={`staff-role-${role}-description`} className="text-xs text-muted-foreground">
                    {ROLE_DESCRIPTIONS[role]}
                  </span>
                </div>
              </div>
            ))}
          </fieldset>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!submittable} isLoading={state.phase === 'submitting'}>
              {state.phase === 'submitting' ? 'Sending invitation' : 'Send invitation'}
            </Button>
          </div>

          <div aria-live="polite" role="status">
            {variant && state.message && (
              <Alert
                variant={variant}
                title={state.resultCode === 'INVITATION_PENDING' ? 'Invitation pending' : 'Invitation not sent'}
                description={state.message}
              />
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
