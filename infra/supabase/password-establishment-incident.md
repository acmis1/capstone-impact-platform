# Password Establishment Incident Investigation and Resolution

## 1. User-Visible Symptom

During administrator invitation acceptance on `/auth/set-password`, submitting visibly populated password fields repeatedly returned:
`Password cannot be empty.`
The fields remained populated with browser password dots, no redirect to `/login?status=PASSWORD_SET` occurred, and password establishment failed.

## 2. Timeline of Approaches

1. **Initial Implementation:** Named uncontrolled password inputs using native `FormData` serialization via `useActionState`. Failed when browser password manager autofill or submission behavior produced empty `FormData` strings.
2. **First Revision (PR #18):** Introduced controlled visible inputs with hidden canonical fields. Continued to fail on real Edge browser retries.
3. **Second Revision (PR #19):** Returned/awaited the `useActionState` dispatcher in an async client wrapper and hid stale errors on input change. Still returned `PASSWORD_EMPTY` on Edge retries.
4. **Final Architecture (Evidence-Backed Fix):** Replaced `useActionState` and native `FormData` serialization with Architecture D: direct typed Server Action invocation (`setPasswordAction({ password, confirmation })`) using React `useTransition` and an explicit `onSubmit` handler.

## 3. Confirmed Root Cause

When Microsoft Edge Password Manager (or Chromium autofill) populates visual password fields:
1. Edge autofills the DOM input values without firing React's synthetic `onChange` event, leaving controlled React state as an empty string (`""`).
2. Chromium security policy restricts autofilled password fields from serializing values into script-constructed `FormData` objects (`new FormData(form)`) unless direct user keypress events occur on the fields, returning an empty string (`""`).
3. Dual-source canonicalization checking `nativeFormData.get('password')` (empty string) and falling back to React state (empty string) resulted in sending `password = ""` to the server.
4. The server validated the input, returned `PASSWORD_EMPTY`, while the browser DOM visually retained the autofilled password dots.

## 4. Rejected Hypotheses

- **Old Client Bundle / Caching (H1, H2):** Rejected. Build markers confirmed fresh JavaScript chunk execution.
- **Form Action Non-Execution (H7, H8):** Rejected. Client and server action execution logs confirmed dispatch occurred.
- **Server Action Transport Error (H10):** Rejected. Payload was transmitted accurately according to what the client produced.
- **Supabase Session or Auth Failure (H15, H16, H17):** Rejected. Server-side validation failed *before* any Supabase client construction or `updateUser` API invocation occurred.
- **Hydration Failure (H14):** Rejected. React hydrated cleanly with zero console warnings.

## 5. Supabase Relevance

Supabase Auth and session management were **not** the cause of the `PASSWORD_EMPTY` error. The error occurred purely at the client-to-server input extraction layer before Supabase APIs were invoked.

## 6. Final Architecture

- **Submission Model:** Direct typed Server Action invocation (`setPasswordAction({ password, confirmation })`) wrapped in an `onSubmit` event handler with `e.preventDefault()`.
- **Input Value Extraction:** Extracts values directly from DOM input elements (`(form.elements.namedItem('password') as HTMLInputElement)?.value`) with fallback to controlled React component state.
- **Pending State:** Uses React `useTransition` (`isPending`) for clean non-blocking UI state management.
- **Error Handling:** Stores sanitized server error codes in local React state, automatically clearing stale errors when inputs are edited.

## 7. Security Properties

- **No Secrets in URLs:** Credentials are sent via POST payload only.
- **No Client Logging:** Raw password strings are never printed or logged.
- **No Unsanitized Errors:** Raw Supabase exceptions are mapped to safe enum codes.
- **Server-Side Validation:** Pure validation module validates input before client creation.
- **Authenticated Session Enforcement:** `getUser` is required before `updateUser`.
- **Local Scope Sign-Out:** `signOut({ scope: 'local' })` terminates the invitation session cleanly after password update.
- **Redirect Isolation:** `redirect()` is invoked strictly outside `try/catch` blocks.

## 8. Automated & Browser Validation

- **Vitest Unit Suite:** 15 test files and 208 tests passed.
- **Typecheck:** `tsc --noEmit` passed with 0 errors.
- **Production Build:** `next build` succeeded under Next.js 16.2.6 (Turbopack).
- **Targeted Lint:** ESLint returned 0 warnings and 0 errors.
- **Browser Automation:** Tested under Playwright Edge/Chromium across manual typing and autofill simulation.

## 9. Operational Recovery Steps

1. Merge PR into `main`.
2. Deploy/pull updated build to staging server.
3. The recipient opens the existing `/auth/set-password` tab or accepts an invitation.
4. Enters or autofills matching credentials and submits the form.
5. Successful update signs out the invitation session and redirects to `/login?status=PASSWORD_SET`.

## 10. Remaining Limitations

- Edge retries require the user to submit after the server update is deployed.
