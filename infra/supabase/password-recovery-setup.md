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
recovery session and `/auth/reset-password` updates the password.

The compatibility fallback uses Supabase's default PKCE ConfirmationURL. It returns to
`/auth/recovery/callback?code=...`, where the server exchanges the code exactly once. PKCE requires
the code verifier stored by the browser that initiated the request; do not claim cross-browser or
cross-device compatibility without a controlled test. The custom token-hash flow is the robust
cross-browser and email-prefetch-protected path.

## Local Mailpit verification

1. Run `npm run setup:local` and `npm run dev:admin`.
2. Open `http://localhost:3000/auth/forgot-password` and submit a synthetic local staff address.
3. Open Mailpit at `http://localhost:54324`.
4. Follow the recovery link, explicitly continue, choose a new synthetic password, and confirm the
   recovery session is signed out at `/login?status=PASSWORD_RESET`.
5. Run `npm run verify:password-recovery-runtime --workspace=apps/admin-cms` for the loopback-only
   Auth/Mailpit verifier.

No hosted project or external email provider is contacted by this workflow.

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
