'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { Alert } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  staffTestAccountMessage,
  type StaffTestAccountResultCode,
  type StaffTestAccountRole,
} from '../../staff/staffTestAccount';
import {
  INITIAL_STAFF_TEST_ACCOUNT_FORM_STATE,
  applyStaffTestAccountOutcome,
  canSubmitStaffTestAccount,
  staffTestAccountAlertVariant,
  toggleStaffTestAccountRole,
} from './staffTestAccountFormState';

const ROLES: readonly StaffTestAccountRole[] = ['reviewer', 'editor'];
const ROLE_LABELS: Record<StaffTestAccountRole, string> = {
  reviewer: 'Reviewer',
  editor: 'Editor',
};
const ROLE_DESCRIPTIONS: Record<StaffTestAccountRole, string> = {
  reviewer: 'Can read projects and complete review decisions.',
  editor: 'Can read and edit project metadata and import projects.',
};

export interface StaffTestAccountFormProps {
  available: boolean;
}

export function StaffTestAccountForm({ available }: StaffTestAccountFormProps) {
  const router = useRouter();
  const [state, setState] = React.useState(INITIAL_STAFF_TEST_ACCOUNT_FORM_STATE);
  const submissionLocked = React.useRef(false);
  const submittable = available && canSubmitStaffTestAccount(state);

  if (!available) return null;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!submittable || submissionLocked.current) return;
    submissionLocked.current = true;
    setState((current) => ({ ...current, phase: 'submitting', resultCode: null, message: null }));

    let outcome: { code: StaffTestAccountResultCode; message: string };
    try {
      const response = await fetch('/api/staff/test-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: state.fullName,
          email: state.email,
          password: state.password,
          confirmation: state.confirmation,
          roles: state.roles,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { code?: string; message?: string; error?: string }
        | null;
      const code = (payload?.code ?? 'PROVISIONING_FAILED') as StaffTestAccountResultCode;
      outcome = {
        code,
        message: payload?.message ?? payload?.error ?? staffTestAccountMessage(code),
      };
    } catch {
      outcome = {
        code: 'PROVISIONING_FAILED',
        message: staffTestAccountMessage('PROVISIONING_FAILED'),
      };
    } finally {
      submissionLocked.current = false;
    }

    setState((current) => applyStaffTestAccountOutcome(current, outcome));
    if (outcome.code === 'ACCOUNT_READY') router.refresh();
  };

  const variant = staffTestAccountAlertVariant(state.resultCode);
  const disabled = state.phase === 'submitting';

  return (
    <Card className="border-information/30">
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Create test account</CardTitle>
          <Badge variant="information" className="w-fit">Staging only</Badge>
        </div>
        <CardDescription>
          Creates a ready-to-use non-admin credential for controlled stakeholder testing on
          staging. No setup email is sent; only Reviewer and Editor authority can be assigned.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5" aria-busy={disabled}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="test-account-full-name" isRequired>Full name</Label>
            <Input
              id="test-account-full-name"
              name="fullName"
              autoComplete="off"
              maxLength={200}
              value={state.fullName}
              disabled={disabled}
              onChange={(event) =>
                setState((current) => ({ ...current, fullName: event.target.value }))
              }
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="test-account-email" isRequired>Email / login</Label>
            <Input
              id="test-account-email"
              name="email"
              type="email"
              autoComplete="off"
              maxLength={254}
              value={state.email}
              disabled={disabled}
              onChange={(event) =>
                setState((current) => ({ ...current, email: event.target.value }))
              }
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="test-account-password" isRequired>Password</Label>
              <Input
                id="test-account-password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                value={state.password}
                disabled={disabled}
                onChange={(event) =>
                  setState((current) => ({ ...current, password: event.target.value }))
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="test-account-confirmation" isRequired>Confirm password</Label>
              <Input
                id="test-account-confirmation"
                name="confirmation"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                value={state.confirmation}
                disabled={disabled}
                onChange={(event) =>
                  setState((current) => ({ ...current, confirmation: event.target.value }))
                }
              />
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">
              Use 12–128 characters. The password is cleared from this page after every attempt.
            </p>
          </div>

          <fieldset className="flex flex-col gap-2.5 border-0 p-0">
            <legend className="text-sm font-medium leading-none">
              Roles
              <span className="ml-0.5 text-destructive" aria-hidden="true">*</span>
              <span className="sr-only"> (required)</span>
            </legend>
            {ROLES.map((role) => (
              <label
                key={role}
                htmlFor={`test-account-role-${role}`}
                className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border border-border/80 px-3 py-2.5 transition-colors hover:bg-muted/50 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30"
              >
                <input
                  id={`test-account-role-${role}`}
                  name="roles"
                  type="checkbox"
                  value={role}
                  className="mt-0.5 h-5 w-5 shrink-0 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  checked={state.roles.includes(role)}
                  disabled={disabled}
                  aria-labelledby={`test-account-role-${role}-label`}
                  aria-describedby={`test-account-role-${role}-description`}
                  onChange={() =>
                    setState((current) => ({
                      ...current,
                      roles: toggleStaffTestAccountRole(current.roles, role),
                    }))
                  }
                />
                <div className="flex flex-col">
                  <span
                    id={`test-account-role-${role}-label`}
                    className="text-sm font-medium leading-none text-foreground"
                  >
                    {ROLE_LABELS[role]}
                  </span>
                  <span
                    id={`test-account-role-${role}-description`}
                    className="mt-1 text-xs leading-relaxed text-muted-foreground"
                  >
                    {ROLE_DESCRIPTIONS[role]}
                  </span>
                </div>
              </label>
            ))}
          </fieldset>

          <Button type="submit" className="w-full sm:w-auto" disabled={!submittable} isLoading={disabled}>
            {disabled ? 'Creating test account' : 'Create test account'}
          </Button>

          <div aria-live="polite" role="status">
            {variant && state.message && (
              <Alert
                variant={variant}
                title={state.resultCode === 'ACCOUNT_READY' ? 'Account ready' : 'Account not created'}
                description={state.message}
              />
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
