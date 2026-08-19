# Staff Password Recovery Setup

This runbook covers repository and local/disposable Supabase behavior only. Hosted Supabase Auth
configuration, SMTP changes, and real recovery email delivery are operator actions performed only
after review and merge.

## Application flows

The login page links to `/auth/forgot-password`. A syntactically valid request calls
`resetPasswordForEmail` from the browser-safe Supabase client with the exact browser-origin
callback `/auth/recovery/callback`. The page always returns the same account-neutral confirmation
after a completed provider request.

Local Supabase uses the preferred recovery template at `templates/recovery.html`:

```text
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/auth/reset-password
```

`/auth/confirm` only captures the token hash into the dedicated short-lived HttpOnly recovery
cookie. A GET does not verify the token. The user must POST the explicit form at
`/auth/recovery/accept`, after which `verifyOtp({ type: 'recovery', token_hash })` establishes the
recovery session. The application then verifies `sub`, `session_id`, and `amr` with `getClaims()`,
registers that exact Auth session in the durable recovery ledger, and issues the signed reset-form
context bound to both identifiers. `/auth/reset-password` updates the password only while verified
user, verified session, durable recovery state, and signed context still agree.

The compatibility fallback uses Supabase's default PKCE ConfirmationURL. It returns to
`/auth/recovery/callback?code=...`, where the server exchanges the code exactly once. PKCE requires
the code verifier stored by the browser that initiated the request; do not claim cross-browser or
cross-device compatibility without a controlled test. The custom token-hash flow is the robust
cross-browser and email-prefetch-protected path.

## Durable session-provenance boundary

Migration `20260819214431_password_recovery_session_provenance.sql` is Migration 0029. The
repository inventory is exactly 29 migrations after it is added.

`public.password_recovery_sessions` contains only:

- `session_id uuid` — primary key and foreign key to `auth.sessions(id) ON DELETE CASCADE`;
- `auth_user_id uuid` — foreign key to `auth.users(id) ON DELETE CASCADE`;
- `purpose text` — fixed by default and check constraint to `password_recovery`;
- `created_at timestamptz` — database creation time.

RLS is enabled with a restrictive deny policy. `PUBLIC`, `anon`, `authenticated`, and
`service_role` have no direct table privileges. Browser and service code therefore use only these
bounded `SECURITY DEFINER` functions, both with `SET search_path = ''` and schema-qualified
references:

- `register_password_recovery_session(p_session_id uuid, p_auth_user_id uuid)` is executable only
  by `service_role`. It verifies Auth-session ownership before insert and returns `REGISTERED`,
  `ALREADY_REGISTERED`, `SESSION_NOT_FOUND`, `SESSION_USER_MISMATCH`, or `VALIDATION_FAILED`.
  `ON CONFLICT DO NOTHING` and the primary key make identical concurrent registration idempotent
  without overwriting contradictory state.
- `get_current_password_recovery_session_state()` is executable only by `authenticated`. It accepts
  no arguments, derives the user from `auth.uid()`, strictly parses `session_id` from `auth.jwt()`,
  resolves that session against `auth.sessions`, joins the ledger to `auth.sessions`, and returns
  only `RECOVERY_SESSION`, `NOT_REGISTERED`, or `INVALID_CONTEXT`.

### Active-session invariant

**For Admin authorization, cryptographic JWT validity is necessary but not sufficient.** The
verified JWT `session_id` must also map to a currently active `auth.sessions` row owned by the
verified user. A missing Auth session is invalid provenance, never an ordinary non-recovery
session.

Supabase documents that every access token carries a `session_id` claim correlating to the
`auth.sessions` primary key, that sign-out deletes the session row while already-issued access
tokens stay valid until their encoded `exp`, and that sensitive operations should therefore
validate the claim against that table. Admin authorization is exactly such an operation here.

The three lookup results have these exact meanings:

| Result | Meaning |
| --- | --- |
| `RECOVERY_SESSION` | A current Auth session exists, belongs to `auth.uid()`, and has a matching `password_recovery_sessions` row. |
| `NOT_REGISTERED` | A current Auth session exists, belongs to `auth.uid()`, and has no password-recovery ledger row. |
| `INVALID_CONTEXT` | The identity/session claim is malformed, the Auth user and session do not match, **or** the JWT `session_id` no longer exists in `auth.sessions`. |

`NOT_REGISTERED` is returned only after Auth-session existence and ownership are positively
proven, so a retained post-sign-out token can never be mistaken for an ordinary Admin session.

The durable row is the authoritative Admin gate for the entire Auth session. The signed
`capstone_password_recovery_context` cookie is a separate, approximately ten-minute permission to
render and submit the reset form. Its HMAC-SHA256 payload is bound to the exact verified user and
session IDs; deleting or expiring it cannot turn the recovery session into an Admin session.

Admin entry is allowed only for exact verified `amr=[password]`, a valid current user/session claim
set, `NOT_REGISTERED` durable state, and an absent recovery context. Durable recovery state always
returns `PASSWORD_RECOVERY_REQUIRED`. Malformed lookup context, RPC failure, `otp`, recovery,
invite, magic-link, empty, mixed, or unknown AMR, and any contradictory signed context all fail
closed before an Admin client or profile/role lookup is created.

## Registration, reset, and termination order

Both explicit TokenHash acceptance and PKCE callback follow the same order:

```text
provider recovery verification or code exchange
→ verified getClaims() user/session/AMR parsing
→ service-role durable registration
→ signed user+session context
→ reset-password page
```

The reset page and action independently repeat verified claims, authenticated no-argument lookup,
and exact signed-context binding. The update action validates plain input before client creation,
calls `updateUser({ password })` once, and then inspects the result of local sign-out. It never calls
staff activation or mutates staff profile, role, or provisioning data.

On successful local sign-out, Supabase deletes the `auth.sessions` row and the recovery row cascades
away; only then may the signed context be cleared and success reported. If sign-out throws or
returns a non-null error, the application does not manually delete durable state, does not clear the
context, and does not claim complete termination. Recovery acceptance, callback, invalid cleanup,
reset, login stale-context handling, and logout all use this rule.

Supabase access tokens cannot be revoked before their encoded expiry. A stale verified token may
therefore remain cryptographically valid after sign-out, but its Auth session row — and any
cascaded ledger row — is gone. The lookup then returns `INVALID_CONTEXT`, and the application
fails closed before creating an Admin client or resolving a staff profile or roles.

This holds for an ordinary password token as well as a recovery token. A retained, still-unexpired
`amr=[password]` access token whose Auth session was deleted at sign-out is rejected with
`AUTHENTICATION_PROVENANCE_INVALID`; exact password provenance does not rescue an inactive session.

## Local Mailpit verification

1. Run `npm run setup:local` and `npm run dev:admin`.
2. Open `http://localhost:3000/auth/forgot-password` and submit a synthetic local staff address.
3. Open Mailpit at `http://localhost:54324`.
4. Follow the recovery link, explicitly continue, choose a new synthetic password, and confirm the
   recovery session is signed out at `/login?status=PASSWORD_RESET`.
5. Run `npm run verify:password-recovery-runtime --workspace=apps/admin-cms` for the loopback-only
   Auth/Mailpit verifier.

No hosted project or external email provider is contacted by this workflow.

The runtime verifier additionally proves session-ID stability across refresh, Auth-session mapping,
concurrent registration, role/function/table privilege denials, context deletion and deterministic
expiry, refresh persistence, stale-token rejection, cascade cleanup, fresh-password authorization,
staff-data invariants, token replay rejection, and complete synthetic fixture cleanup. It prints only
bounded scenario names and never prints credentials, claims, identity values, or cookie contents.

## Hosted Auth and Render requirements

After review and merge, an authorized operator must separately configure:

- the exact hosted Site URL;
- exact redirect allow-list entries for `<public-origin>/auth/confirm` and
  `<public-origin>/auth/recovery/callback` (no wildcard);
- the hosted Reset Password template using the preferred token-hash URL above, when the project is
  eligible to customize templates;
- `CAPSTONE_AUTH_FLOW_SECRET` on Render as a dedicated server-only value containing at least 32
  random bytes, never reused from Supabase keys, JWT/database credentials, SMTP credentials, or
  another provider;
- custom SMTP if delivery outside Supabase organization members is required.

Supabase changed new Free-plan projects using the default email provider on 3 June 2026: they
cannot customize Auth email templates unless they configure custom SMTP. Existing Free projects
created before that date retain their existing templates. The repository cannot establish which
case applies to the hosted project without an authorized hosted inspection, so the PKCE callback
remains required and hosted prefetch protection must not be claimed until the template is verified.

The Auth email-sending and password-recovery endpoints retain Supabase's provider rate limits. The
application adds only a pending submission lock and generic resend guidance; it does not add a
database limiter or weaken provider controls.

On Render, every confirmation and recovery callback redirect uses the strictly validated
`RENDER_EXTERNAL_URL` through `resolveCanonicalPublicOrigin`. The internal listener origin and
Host/Forwarded/X-Forwarded-* headers are never redirect inputs. Outside Render, only the validated
direct request origin is accepted. Invalid origin configuration fails closed.

References:

- [Supabase password recovery](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail)
- [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [Supabase email templates and prefetching](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Supabase Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits)
- [Supabase Free-plan template change](https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier)
- [Supabase user sessions and `session_id`](https://supabase.com/docs/guides/auth/sessions)
- [Supabase verified `getClaims()`](https://supabase.com/docs/reference/javascript/auth-getclaims)
- [Supabase sign-out and stale access tokens](https://supabase.com/docs/guides/auth/signout)
- [Supabase database-function security](https://supabase.com/docs/guides/database/functions)
- [Supabase Row Level Security and Auth helpers](https://supabase.com/docs/guides/database/postgres/row-level-security)

## Hosted deployment and rollback order

This task does not apply the migration or configure Auth on a hosted project. After merge and an
independent security review, an authorized operator must deploy in this order: apply Migration 0029,
deploy the application code that depends on its functions, configure the dedicated Render signing
secret and exact hosted Auth URLs/templates, and only then perform a controlled hosted recovery
test. Never deploy the application dependency before the migration.

Rollback is intentionally gated and must be performed only by an authorized operator:

1. Disable or revert all recovery entry points first.
2. Ensure no active password-recovery Auth sessions remain.
3. Verify `public.password_recovery_sessions` is empty.
4. Drop `public.get_current_password_recovery_session_state()`.
5. Drop `public.register_password_recovery_session(uuid, uuid)`.
6. Drop `public.password_recovery_sessions`.
7. Only then remove application dependencies on those contracts.

Do not delete ledger rows as a shortcut for rollback while their Auth sessions remain usable.
