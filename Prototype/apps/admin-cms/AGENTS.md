# Admin/CMS Agent Instructions & Engineering Rules

## 1. Application Architecture & Technology Stack
- **Framework**: Next.js App Router with TypeScript.
- **Rendering Strategy**: React Server Components (RSC) by default. Client Components (`'use client'`) must be restricted strictly to interactive elements requiring state or browser APIs.
- **Security Boundaries**: Strictly preserve authentication and authorization boundaries. Never import or invoke Supabase `service_role` keys or elevated server clients within browser code or Client Components.
- **Server Action Security**: Server Actions and route handlers must re-verify authentication and user roles before executing any operations.

## 2. UI Engineering & Styling Standards
- **Future Approved Stack**: Tailwind CSS v4, local `shadcn`-style components built on Radix UI accessible primitives, TanStack Table, and Lucide React icons.
- **Design Tokens**: No raw hex colors outside centralized design-token definitions. No inline style objects (`style={{ ... }}`) for production Admin/CMS interfaces.
- **Identity & Aesthetics**: RMIT identity must be restrained, modern, and token-driven. No copied vendor UI branding.
- **Interface Assets**: Never use emojis as UI icons or button graphic elements; use approved SVG icons.

## 3. Accessibility & Interaction Guidelines
- **Accessible Primitives**: Hand-built dialogs, dropdown menus, selects, tooltips, or popovers are forbidden. Use accessible Radix/shadcn primitives.
- **Semantic HTML & Focus**: Require semantic HTML elements, visible focus indicators (`:focus-visible`), explicit form labels, and complete keyboard navigation support.
- **Motion & Responsiveness**: Deliberately support `prefers-reduced-motion`. Responsive layout changes must be deliberate and non-destructive.

## 4. Application States & UX Principles
- **Mandatory UX States**: Every view and interactive component must explicitly handle Loading, Empty, Error, Disabled, and Permission-Denied states.
- **Confirmation & Safety**: Destructive actions require explicit confirmation dialogs with clear statement of consequences.
- **No Operational Leaks**: Non-technical staff must never be prompted or instructed to execute terminal commands or technical scripting from the production UI.
- **Data Collections**: Tables and index views must be engineered to support realistic large enterprise collections.
- **Dependencies**: Dependencies may only be added in separately approved implementation PRs, not during scaffolding or documentation tasks.

---

### 5. Detailed Component & Engineering Requirements

#### 5.1 Component Composition & Rendering Scope
- Default to React Server Components (RSC) for data fetching, page layouts, and static content rendering.
- Isolate interactive widgets (e.g., filter toolbars, dialogs, rich text inputs) into focused Client Components (`'use client'`).
- Prevent prop-drilling by leveraging clear component composition and composition patterns.

#### 5.2 Form Design & Field Validation
- Use structured field validation schemas for all form inputs.
- Display inline error messages tied to input IDs with proper `aria-describedby` references.
- Surface validation summaries for multi-step form submissions or batch workflows.

#### 5.3 Table & Data Grid Standards
- Build data tables using TanStack Table v8 for headless state control.
- Support pagination, multi-column sorting, global search, and multi-faceted filtering out of the box.
- Implement accessible row selection checkboxes and persistent bulk action toolbars.

#### 5.4 Dialogs, Drawers & Overlays
- Modal dialogs and slide-out drawers must trap focus and close on `Escape` key press.
- Return focus to the triggering element upon modal closure.
- Provide descriptive `aria-labelledby` and `aria-describedby` attributes for screen readers.

#### 5.5 Design System Token Integration
- All visual attributes (color, typography, spacing, shadows, radius) must reference CSS custom properties defined in the global design token contract.
- Primary brand accent (RMIT Red) must be applied deliberately to call-to-action buttons, active navigation indicators, and key metric callouts.
- Provide high-contrast visual focus rings for all interactive controls across both light and dark themes.

#### 5.6 Error Recovery & Fallbacks
- Wrap route segments in Next.js `error.tsx` boundary components to prevent full-page crashes.
- Provide human-readable error messages with safe recovery actions (e.g., "Retry Request" or "Return to Overview").
- Never leak raw stack traces or internal backend error objects to end users.

#### 5.7 Internationalization & Localization Prep
- Structure user-facing strings to support internationalization and localized text formatting.
- Ensure date, time, and number formats comply with user locale settings across all table columns and form fields.

#### 5.8 Performance Monitoring & Micro-Optimizations
- Avoid unnecessary re-renders in Client Components through proper memoization techniques.
- Lazy load heavy modal dialogs and complex drawer components to minimize initial bundle overhead.

#### 5.9 Audit Trail Logging Standards
- Record all user actions resulting in data mutations or publishing status shifts in client audit log payload contracts.
- Ensure event timestamps use ISO 8601 formatting with full UTC timezone offset specification.
