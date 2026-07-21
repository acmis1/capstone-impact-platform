# Password Establishment Incident Investigation and Resolution

## 1. Confirmed Observations

During administrator invitation acceptance on `/auth/set-password`:
- Submitting visibly populated password fields produced `PASSWORD_EMPTY`.
- The application-submitted values diverged from the visual presentation in the browser.
- React controlled state can remain empty when browser autofill or input restoration does not trigger synthetic input/change events.
- The previous fallback combination produced an empty server payload in the reproduced diagnostic harness.
- `PASSWORD_EMPTY` was returned by server-side input validation *before* any Supabase API call or client construction occurred. Supabase Auth and database policies were **not** reached for that failure.

## 2. Evidence and Technical Analysis

The confirmed failure boundary was client-side credential extraction before the Server Action's validation. Browser-populated visible values were not reliably represented in the React or FormData sources used by prior implementations.

Because the exact browser-internal runtime mechanism for every real Edge retry was not independently observable, the permanent solution removes reliance on native `FormData` serialization and un-triggered React state by:
1. Extracting the current DOM input values (`passwordRef.current?.value`) at submit time via element refs.
2. Using controlled React component state as a fallback if DOM refs are empty.
3. Transmitting credentials using a strict typed object payload (`setPasswordAction({ password, confirmation })`).
4. Preventing duplicate submissions synchronously using a `useRef` lock.

FORMDATA_SECURITY_POLICY_CLAIM_REMOVED=true

## 3. Timeline of Solution Iterations

1. **Initial Implementation:** Named uncontrolled password inputs using native `FormData` serialization via `useActionState`.
2. **First Revision (PR #18):** Introduced controlled visible inputs with hidden canonical fields.
3. **Second Revision (PR #19):** Wrapped the `useActionState` dispatcher in an async client function and hid stale errors on input edit.
4. **Final Architecture (Strict Typed Action + Submit-Time DOM Extraction):** Replaced `useActionState` and native `FormData` serialization with Architecture D:
   - Direct typed Server Action invocation (`setPasswordAction({ password, confirmation })`).
   - Form `onSubmit` event handler with `e.preventDefault()`.
   - Submit-time DOM extraction using input `useRef` handles.
   - Synchronous submission lock (`submissionLockRef`).
   - React `useTransition` (`isPending`) for pending state.
   - Handled action rejections cleanly to prevent unhandled promise rejections.

## 4. Security Properties

- **No Credentials in URLs:** Sent strictly via POST body payload.
- **No Client Logging:** Raw credentials are never printed to console or logs.
- **Strict Server Input Guard:** `setPasswordAction` validates that input is a non-array, non-FormData object containing valid string properties before invoking validation.
- **Server-Side Validation:** Pure validation module validates input before client creation.
- **Authenticated Session Enforcement:** `getUser` is required before `updateUser`.
- **Local Scope Sign-Out:** `signOut({ scope: 'local' })` terminates the invitation session cleanly after password update.
- **Redirect Isolation:** `redirect()` is invoked strictly outside `try/catch` blocks.

## 5. Automated Validation Summary

- **Vitest Unit Suite:** 16 test files passed.
- **TypeScript:** `tsc --noEmit` passed cleanly with 0 errors.
- **Production Build:** `next build` succeeded under Next.js 16.2.6 (Turbopack).
- **Targeted Lint:** ESLint returned 0 warnings and 0 errors.

## 6. Operational Recovery Steps

1. Merge PR into `main`.
2. Deploy updated build to staging server.
3. The recipient opens `/auth/set-password` or accepts an invitation.
4. Enters or autofills matching credentials and submits the form.
5. Successful update signs out the invitation session and redirects to `/login?status=PASSWORD_SET`.

## 7. Incident Resolution & Operational Closure

- **Operational Status:** Operationally Resolved.
- **Verification Summary:**
  - The replacement invitation acceptance and password establishment flow on `/auth/set-password` succeeded without returning `PASSWORD_EMPTY`.
  - The temporary invitation session was signed out cleanly and the browser reached `/login?status=PASSWORD_SET`.
  - Staging administrator bootstrap linkage (`bootstrap_initial_admin`) subsequently succeeded after applying corrective migration 0006 (`CREATED`, `provisioned=1`).
  - Manual browser authentication testing succeeded in Edge, verifying successful dashboard access to `/admin` and `/admin/imports`, header rendering with the ADMIN role, and clean logout redirection.
  - Zero passwords, tokens, keys, or credentials were logged or recorded.
