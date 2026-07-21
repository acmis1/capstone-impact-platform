# Supabase Auth Invitation Setup

This document describes the configuration and operational workflow for administrative console invitations.

---

## ⚠️ Staging Status & Scope Guidance

### A. Current Staging Environment
In the active staging environment (`capstone-admin-cms-staging-2026` located in Singapore):
* **Verification Complete:** Initial administrator invitation, password establishment, bootstrap linkage, readiness checks, and login/logout verification have already been completed and verified.
* **Do Not Resend:** Do not resend or regenerate invitations for the active administrator.
* **Do Not Delete:** Never delete the active staging administrator.
* **Do Not Rerun Bootstrap:** Do not rerun the initial bootstrap operation.
* **Future Provisioning:** Onboarding additional school staff or testing reviewer/editor roles requires a separately designed, reviewed, and approved multi-user provisioning workflow.

### B. New Isolated Setup (Operational Sequencing)
When configuring a genuinely fresh isolated staging or production environment, follow this safe sequence to provision the initial administrator:
1. **Confirm Environment:** Ensure you are connected to the correct isolated target environment.
2. **Disable Self-Registration:** Verify in your Supabase Auth settings that self-registration is disabled.
3. **Configure URL Settings:** Set the exact Site URL and allow-listed redirect URLs in the Supabase console.
4. **Configure Email Template:** Update the Invite User template to target the secure redirection route.
5. **Verify Auth Directory:** Perform a read-only check of the Auth directory to inspect current accounts.
6. **Handle Unexpected Users:** If unexpected Auth identities exist, **stop immediately** for operator review. Do not delete existing accounts merely to achieve a zero-user count.
7. **Send One Invitation:** Send exactly one invitation to the approved email address of the intended initial administrator.
8. **Establish Password:** Recipient privately accepts the invitation and sets a password.
9. **Execute Bootstrap:** Run the initial admin bootstrap script (only after separate authorization).
10. **Verify Readiness:** Execute the read-only readiness checker.
11. **Perform Login Test:** Perform manual login and session logout verification in the browser.

---

## URL Configuration

In the Supabase Dashboard, navigate to **Authentication** → **URL Configuration** and apply the settings below:

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

---

## Email Template Configuration

In **Authentication** → **Email Templates** → **Invite User**, update the template body to direct the user through the token verification route:

```html
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/auth/set-password
```

The incoming email-link URL contains the `token_hash` query parameter.

---

## Prefetch-Protection Two-Step Acceptance Flow

GET requests from automated link scanners, prefetchers, or email servers do not consume the invitation token. The application implements this security property using a two-step capture-then-accept architecture:

1. **capture-route GET (/auth/confirm):**
   * The user (or scanner) GETs `/auth/confirm?token_hash=...&type=invite`.
   * The Route Handler validates parameters. If validation fails, it immediately clears any stale temporary invitation cookie and redirects to `/login` with an error code.
   * If valid, the GET route places the trimmed `token_hash` into a short-lived `Set-Cookie` header (`capstone_invitation_token_hash`).
   * The capturing route handler **does not** construct a Supabase client or call the Auth `verifyOtp` API.
   * It responds with a `303 See Other` redirect to the clean URL `/auth/confirm/accept` (which contains no parameters).
   * The token hash is not placed in the redirect `Location` header, HTML response body, form fields, or client storage.
   * All responses are decorated with security headers to prevent caching (`Cache-Control: no-store, max-age=0`, `Pragma: no-cache`), referrer forwarding (`Referrer-Policy: no-referrer`), and indexing (`X-Robots-Tag: noindex, nofollow, noarchive`).

2. **explicit acceptance page (/auth/confirm/accept):**
   * Renders a generic "Confirm Invitation" page with an explicit **Accept invitation** form button.
   * Rendering does not initialize a Supabase client or verify the token.
   * The user must explicitly press **Accept invitation** to submit a POST request back to a Server Action.

3. **acceptance server action:**
   * Reads the `capstone_invitation_token_hash` from the secure HttpOnly cookie.
   * Deletes the cookie immediately from the browser to prevent token reuse, replays, or leakages.
   * Re-validates the token format and calls the Supabase Auth `verifyOtp` API exactly once.
   * Redirects to `/auth/set-password` on success, or to a sanitized login error page on failure.

---

## 🛡️ Invitation & Onboarding Security Rules

* **Single Target Destination:** Invitation success always routes exclusively to `/auth/set-password`.
* **No Alternate Destinations:** Route paths such as `/admin` or `/login` are strictly blocked and rejected as invitation confirmation success targets.
* **Historical Incident Fact:** A prior invitation whose URL exposed a bearer token (access_token/refresh_token in the hash fragment) was compromised and must never be reused. This historical incident does not justify or permit routine account deletion in current staging.

> [!WARNING]
> * **No Auto-Deletion:** Never delete an Auth user automatically.
> * **No Routine Deletion:** Never delete the currently linked initial administrator as part of routine setup or environment maintenance.
> * **Remediation Boundary:** Unexpected existing Auth identities require manual operator review and a separately approved remediation plan. Do not delete users merely to achieve a zero-user count.
> * **Staging Integrity:** Current staging must not be reset, re-seeded, or mutated merely because this setup guide exists.
> * **No SQL Inserts:** Never paste Auth UUIDs into SQL, and never manually insert or update `admin_users` or `user_roles` rows.
> * **No PII Sharing:** Never send passwords, invitation tokens, names, emails, UUIDs, or credentials to coding agents or chat.

---

## 💻 Operational Execution Commands

Always run canonical root-level commands from the repository root:

* **Link Initial Administrator:**
  ```bash
  npm run link:admin-staging
  ```
* **Verify Staging Readiness:**
  ```bash
  npm run check:admin-auth
  ```

### Workspace Commands (Alternative)
Only when run inside the `apps/admin-cms` directory context:
```bash
cd apps/admin-cms
npm run link:staging-admin
npm run check:staging-auth
```
