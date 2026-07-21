# Admin/CMS Agent Instructions & Engineering Rules

## 1. Application Architecture & Technology Stack
- **Framework**: Next.js App Router with TypeScript.
- **Rendering Strategy**: React Server Components (RSC) by default. Client Components (`'use client'`) are restricted strictly to required browser interaction.
- **Security Contracts**: Preserve existing authentication, authorization, and route-security contracts. Never import a `service_role` client into browser code. Server Actions and mutation routes must re-authorize on the server.

## 2. UI Engineering & Styling Standards
- **UI Stack Direction**: Tailwind CSS v4, semantic CSS-variable design tokens, locally owned `shadcn`-style components based on Radix accessible primitives, TanStack Table, Lucide icons. Dependencies are added only in separately approved implementation tasks.
- **Styling Discipline**: Do not introduce new inline style objects in production Admin/CMS UI. When touching an existing inline-styled surface, migrate only that affected surface unless broader migration is explicitly authorized.
- **Design Tokens**: Raw brand/status colors belong in centralized semantic tokens. Approved Tailwind spacing, sizing, and layout utilities may be used directly; do not require a custom CSS variable for every numeric value.
- **Theme & Identity**: Light-first interface; dark-mode compatibility may be preserved but dark mode is not currently a required deliverable. No emoji as interface icons. Do not copy another vendor's branding.

## 3. Accessibility & Interaction Guidelines
- **Accessible Primitives**: Use accessible primitives for dialogs, menus, tooltips, popovers, and selects. Hand-built non-primitive overlays are forbidden.
- **Accessibility Standards**: Require semantic landmarks, visible focus indicators, complete keyboard interaction, explicit labels, proper descriptions, and error relationships.
- **UX States & Motion**: Support `prefers-reduced-motion`. Do not use color-only status communication. Loading, empty, error, disabled, and permission-denied states are mandatory.

## 4. Operational UX & Safety
- **Staff Safety**: Non-technical staff must never be instructed to run terminal commands from production UI.
- **Controls & Confirmations**: Do not render fake or non-functional navigation controls. Destructive actions require explicit confirmation and clear statement of consequences.
- **Resilience & Forms**: Long-running operations need progress and recovery states. Forms require unsaved-change handling where data loss is possible. Tables must support realistic collections and server-side scaling.

## 5. Security, Server-Side Audit & Performance
- **Actor Identity & Audit**: Browser payloads must never be trusted for actor identity. Authenticated actor identity must be established server-side. Mutation timestamps and audit attribution must be generated server-side using UTC ISO 8601 timestamps. Never show raw backend errors or secret configuration values.
- **Performance Optimization**: Optimize based on empirical evidence. Do not mandate blanket memoization or blanket lazy loading. Avoid unnecessary Client Components and excessive client-side state.

---

### Detailed Component & Engineering Requirements

#### Component Composition & Rendering Scope
- Default to React Server Components (RSC) for data fetching, page layouts, and static content rendering.
- Isolate interactive widgets (e.g., filter toolbars, dialogs, rich text inputs) into focused Client Components (`'use client'`).
- Prevent prop-drilling by leveraging clear component composition patterns.

#### Form Design & Field Validation
- Use structured field validation schemas for all form inputs.
- Display inline error messages tied to input IDs with proper `aria-describedby` references.
- Surface validation summaries for multi-step form submissions or batch workflows.

#### Table & Data Grid Standards
- Build data tables using TanStack Table v8 for headless state control.
- Support pagination, multi-column sorting, global search, and multi-faceted filtering out of the box.
- Implement accessible row selection checkboxes and persistent bulk action toolbars.

#### Dialogs, Drawers & Overlays
- Modal dialogs and slide-out drawers must trap focus and close on `Escape` key press.
- Return focus to the triggering element upon modal closure.
- Provide descriptive `aria-labelledby` and `aria-describedby` attributes for screen readers.

#### Design System Token Integration
- All visual attributes (color, typography, spacing, shadows, radius) must reference CSS custom properties defined in the global design token contract.
- Primary brand accent (RMIT Red) must be applied deliberately to call-to-action buttons, active navigation indicators, and key metric callouts.
- Provide high-contrast visual focus rings for all interactive controls across both light and dark themes.

#### Error Recovery & Fallbacks
- Wrap route segments in Next.js `error.tsx` boundary components to prevent full-page crashes.
- Provide human-readable error messages with safe recovery actions (e.g., "Retry Request" or "Return to Overview").
- Never leak raw stack traces or internal backend error objects to end users.

#### Internationalization & Localization Prep
- Structure user-facing strings to support internationalization and localized text formatting.
- Ensure date, time, and number formats comply with user locale settings across all table columns and form fields.

#### Performance Monitoring & Micro-Optimizations
- Avoid unnecessary re-renders in Client Components through proper memoization techniques.
- Lazy load heavy modal dialogs and complex drawer components to minimize initial bundle overhead.

#### Audit Trail Logging Standards
- Record all user actions resulting in data mutations or publishing status shifts in client audit log payload contracts.
- Ensure event timestamps use ISO 8601 formatting with full UTC timezone offset specification.

#### Code Quality & Refactoring Guardrails
- Maintain explicit TypeScript types across all API payloads, component props, and state definitions.
- Avoid broad refactoring outside explicitly assigned task components.
- Ensure unit and integration tests accompany code changes before submitting PRs.

#### Security Isolation & Data Protection
- Do not log sensitive user information, credentials, or session tokens to client console logs or analytics services.
- Ensure all mutation endpoints validate CSRF tokens or equivalent request origin headers.
