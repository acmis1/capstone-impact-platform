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

The incoming email-link URL contains the `token_hash` query parameter.

## Prefetch-Protection Two-Step Acceptance Flow

GET requests from automated link scanners, prefetchers, or email servers do not consume the invitation token. The application implements this security property using a two-step capture-then-accept architecture:

1. **capture-route GET (/auth/confirm):**
   - The user (or scanner) GETs `/auth/confirm?token_hash=...&type=invite`.
   - The Route Handler validates parameters. If validation fails, it immediately clears any stale temporary invitation cookie and redirects to `/login` with an error code.
   - If valid, the GET route places the trimmed `token_hash` into a short-lived `Set-Cookie` header (`capstone_invitation_token_hash`).
   - The capturing route handler **does not** construct a Supabase client or call the Auth `verifyOtp` API.
   - It responds with a `303 See Other` redirect to the clean URL `/auth/confirm/accept` (which contains no parameters).
   - The token hash is not placed in the redirect `Location` header, HTML response body, form fields, or client storage.
   - All responses (both success redirects and parameter-validation failures) are decorated with security headers to prevent caching (`Cache-Control: no-store, max-age=0`, `Pragma: no-cache`), referrer forwarding (`Referrer-Policy: no-referrer`), and indexing (`X-Robots-Tag: noindex, nofollow, noarchive`).

2. **explicit acceptance page (/auth/confirm/accept):**
   - Renders a generic "Confirm Invitation" page with an explicit **Accept invitation** form button.
   - Rendering does not initialize a Supabase client or verify the token.
   - The user must explicitly press **Accept invitation** to submit a POST request back to a Server Action.

3. **acceptance server action:**
   - Reads the `capstone_invitation_token_hash` from the secure HttpOnly cookie.
   - Deletes the cookie immediately from the browser to prevent token reuse, replays, or leakages.
   - Re-validates the token format and calls the Supabase Auth `verifyOtp` API exactly once.
   - Redirects to `/auth/set-password` on success, or to a sanitized login error page on failure.

### Staging Invitation Security Rules

* **Single Target Destination:** Invitation success always routes exclusively to `/auth/set-password`.
* **No Alternate Destinations:** Route paths such as `/admin` or `/login` are strictly blocked and rejected as invitation confirmation success targets.
* **No Bearer Token Reuse:** The prior invitation whose URL exposed a bearer token (access_token/refresh_token in the hash fragment) is compromised and must never be reused.
* **Zero-User Precondition:** The previously invited/created Auth user must be manually deleted from the Supabase Dashboard, and the dashboard must show exactly zero Auth users, before a replacement invitation is sent.
* **No Early Invites:** No replacement invitation may be sent until this PR is reviewed, merged, and the application is running in staging.

## Operational Execution Sequence

Always follow this sequence when onboarding the initial administrator:

1. **Deploy the Invitation Flow:** Review, merge, and deploy these routes to staging.
2. **Configure Supabase URL Settings:** Configure the exact Site URL and redirect URL allow-list in the Supabase console.
3. **Configure the Email Template:** Update the Invite User template to include the `/auth/confirm` path.
4. **Clean Staging Auth State:** Manually delete any existing Auth users in the dashboard to ensure a clean starting state with zero users.
5. **Send exactly one new invitation:** Generate the invitation from the Supabase Auth dashboard only after deployment is fully operational.
6. **Accept invitation and set password:** Complete the two-step flow from the email link to private password setup, routing to `/auth/confirm/accept` and then `/auth/set-password`.
7. **Confirm exactly one Auth user exists:** Verify the user is registered in `auth.users` in Supabase.
8. **Link administrator profile:** Execute the separately approved `link:staging-admin` bootstrap script.
9. **Verify credentials status:** Run the `check:staging-auth` script.
10. **Perform manual login test:** Attempt to sign in to the Console dashboard at `/login`.
