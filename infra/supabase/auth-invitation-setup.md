# Supabase Auth Invitation Setup

This document describes the configuration and operational workflow for administrative console invitations.

## URL Configuration

In the Supabase Dashboard, navigate to **Authentication** → **URL Configuration** and apply the following settings:

### Local Development

* **Site URL:**
  `http://localhost:3000`
* **Redirect URLs (Allow-list):**
  `http://localhost:3000/auth/confirm`

### Staging Deployment

* **Site URL:**
  Set to the exact HTTPS origin of the staging application.
* **Redirect URLs (Allow-list):**
  Add the exact HTTPS staging confirmation route: `<staging-origin>/auth/confirm`

*Note: Do not use wildcards in allow-lists unless specifically reviewed.*

## Email Template Configuration

In **Authentication** → **Email Templates** → **Invite User**, update the template body to direct the user through the token verification route:

```html
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/auth/set-password
```

This ensures the invitation token is validated server-side and an authenticated cookie-bound SSR session is established before prompting the user to update their credentials.

## Operational Execution Sequence

Always follow this sequence when onboarding the initial administrator:

1. **Deploy the Invitation Flow:** Merge and deploy these routes to staging.
2. **Configure Supabase URL Settings:** Configure the exact Site URL and redirect URL allowlist in the Supabase console.
3. **Configure the Email Template:** Update the Invite User template to include the `/auth/confirm` path.
4. **Send exactly one new invitation:** Generate the invitation from the Supabase Auth dashboard.
5. **Accept invitation and set password:** Complete the flow from the email link to private password setup.
6. **Confirm exactly one Auth user exists:** Verify the user is registered in `auth.users` in Supabase.
7. **Link administrator profile:** Execute the separately approved `link:staging-admin` bootstrap script.
8. **Verify credentials status:** Run the `check:staging-auth` script.
9. **Perform manual login test:** Attempt to sign in to the Console dashboard at `/login`.
