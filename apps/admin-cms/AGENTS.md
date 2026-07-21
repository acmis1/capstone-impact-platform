<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## 1. Application Architecture & Security Boundaries
- **Framework & Rendering**: Next.js App Router with TypeScript. React Server Components (RSC) by default; Client Components (`'use client'`) are restricted strictly to required browser interaction.
- **Authentication & Route Security**: Preserve existing authentication, authorization, and route-security contracts. Never import a `service_role` client into browser code. Server Actions and mutation routes must re-authorize on the server.

## 2. UI Engineering & Styling Discipline
- **UI Stack Direction**: Tailwind CSS v4, semantic CSS-variable design tokens, locally owned `shadcn`-style components based on Radix accessible primitives, TanStack Table, Lucide icons. Dependencies are added only in separately approved implementation tasks.
- **Styling Standards**: Do not introduce new inline style objects in production Admin/CMS UI. When touching an existing inline-styled surface, migrate only that affected surface unless broader migration is explicitly authorized.
- **Design Tokens vs Utilities**: Semantic CSS variables are reserved for theme and semantic design tokens (brand, surfaces, feedback colors). Approved Tailwind spacing, sizing, typography, and layout utilities may be used directly without requiring a custom CSS variable for every numeric value.
- **Theme & Identity**: Light-first interface; dark-mode compatibility may be preserved but dark mode is not currently a required deliverable. No emoji as interface icons. Do not copy another vendor's branding.

## 3. Accessibility & UX Requirements
- **Accessible Primitives**: Use accessible primitives for dialogs, menus, tooltips, popovers, and selects. Hand-built non-primitive overlays are forbidden.
- **Accessibility Standards**: Require semantic landmarks, visible focus indicators, complete keyboard interaction, explicit labels, proper descriptions, and error relationships. Target WCAG 2.2 AA.
- **Applicable UX States**: Relevant views and operational flows must explicitly handle applicable Loading, Empty, Error, Disabled, and Permission-Denied states. Support `prefers-reduced-motion`. Do not rely on color-only status communication.

## 4. Operational Safety & Resilience
- **Staff Safety**: Non-technical staff must never be instructed to run terminal commands from production UI.
- **Controls & Confirmations**: Do not render fake or non-functional navigation controls. Destructive actions require explicit confirmation and clear statement of consequences.
- **Form Resilience**: Long-running operations need progress and recovery states. Forms require unsaved-change handling where data loss is possible. Tables must support realistic collections and server-side scaling.

## 5. Server-Side Audit, Identity & Evidence-Based Performance
- **Server-Side Identity & Audit**: Browser payloads must never be trusted for actor identity. Authenticated actor identity and audit attribution must be derived server-side. Timestamps are server-generated UTC ISO 8601 values. Never show raw backend errors or secret configuration values.
- **Evidence-Based Performance**: Optimize based on empirical performance evidence. Do not mandate blanket memoization or blanket lazy loading. Avoid unnecessary Client Components and excessive client-side state.
