# Admin/CMS UI System & Architecture Contract

## A. Product Positioning
The Capstone Impact Platform Admin/CMS is an enterprise editorial operations platform designed specifically for non-technical school staff, course coordinators, and academic administrators. It is not a generic developer dashboard or database GUI. Its focus is efficient project curation, batch importing, confirmation tracking, metadata validation, and publishing governance.

## B. Industry Benchmark Synthesis
Useful interaction and information architecture patterns to learn from without copying vendor branding:
- **Directus**: Module navigation, collection management, advanced filters, saved bookmarks, package importing, batch archiving, and detailed audit activity logs.
- **Shopify Admin**: High-density searchable/filterable/sortable/paginated resource tables, bulk selection actions, and sticky action headers.
- **Sanity Studio**: Content-structure navigation, multi-pane editing, contextual right rails, and real-time validation feedback.
- **Contentful**: Structured field editing with publishing status tags, workflow tasks, and side-by-side preview panels.
- **Payload CMS**: Collapsible application shell, high-performance long forms, version history, visual diff comparisons, and controlled rollback.
- **Atlassian Design System**: Grid discipline, standardized elevation/tokens, clear visual hierarchy, accessible primitives, and consistent micro-interactions.

## C. Design Principles
1. **Task-First Layouts**: Surface immediate operational actions without clutter.
2. **Clarity Before Decoration**: Functional visual hierarchy over decorative graphics.
3. **Progressive Disclosure**: Expose advanced parameters only when required.
4. **Dense But Readable**: High information density balanced with generous line height and clear typography.
5. **Keyboard-First Design**: Full keyboard accessibility for repetitive administrative operations.
6. **Accessibility by Construction**: Built atop accessible primitives matching WCAG 2.2 AA target standards.
7. **Explicit System Status**: Unambiguous visual indicators for draft, review, ready, published, and archived states.
8. **Reversible & Governed Operations**: Provide safe undo and controlled rollback mechanisms for critical editorial changes.
9. **Auditability**: Track all status shifts, edits, and publishing events with server-side derived timestamps and audit attribution.
10. **Consistent Terminology**: Standardized terminology across navigation, notifications, and modals.
11. **Responsive Without Removing Critical Actions**: Adapt layouts across viewports without omitting essential tools.
12. **Restrained Motion**: Subtle, functional animations respecting `prefers-reduced-motion`.
13. **No Dark-Pattern Confirmations**: Clear, explicit dialogs for destructive actions without misleading copy.

## D. Current Active Staging Routes
Current active staging routes:
- `/admin`
  Current project index / dashboard;
- `/admin/imports`
  Current import-batch history / list;
- `/admin/imports/{batchId}`
  Current read-only import-batch inspection and validation-detail view;
- `/admin/projects/{publicId}`
  Current project inspection and authorized review-action view.

Note: The current project index is rendered at `/admin`. No standalone `/admin/projects` index currently exists. Current active staging routes do not claim to provide a completed New Import UI, editable spreadsheet reconciliation, a full metadata editor, or a standalone `/admin/projects` index. Target navigation routes are planned and must not be shown as working until implemented.

## E. Target Information Architecture
Target navigation modules (planned future routes):
- **Overview** (Planned)
- **Projects** (Planned)
  - All Projects
  - Needs Review
  - Ready to Publish
  - Archived
- **Imports** (Planned)
  - New Import
  - Import History
  - Validation Issues
- **Confirmations** (Planned)
  - Awaiting Response
  - Correction Requests
  - Completed
- **Publishing** (Planned)
  - Ready to Publish
  - Publication History
  - Removal Queue
  - Rollback
- **Administration** (Planned)
  - Users and Roles
  - Programs and Categories
  - Audit Log
  - System Health

## F. Application Shell
MVP shell requirements:
- Responsive desktop sidebar and mobile navigation drawer;
- Compact top bar with breadcrumbs, page title, contextual actions, environment indicator (Staging/Production), administrator menu, logout, and skip-to-content link;
- Global system-status and notification display area.

Later/conditional shell features (must not be rendered before supporting backend behavior exists):
- Global search input;
- Notification center badge;
- Dynamic navigation counter badges.

## G. Design-Token Direction
Semantic design-token structure using CSS variables:
- **Brand Tokens**: RMIT Red (`var(--color-brand-primary)`) used deliberately for identity accents and primary actions, Slate Navy (`var(--color-brand-secondary)`).
- **Background & Surfaces**: Base background, elevated surfaces, inset surfaces, overlay surfaces.
- **Text**: Primary, secondary, muted, inverse, brand accent.
- **Borders & Focus**: Subtle borders, strong borders, interactive visual focus ring (`:focus-visible`).
- **Action Semantics**: Primary, secondary, ghost, destructive actions.
- **Feedback Semantics**: Success, warning, critical, information.
- **Spacing, Typography & Breakpoints**: Standardized spacing scale, typography scale, radius values, elevation tokens, motion tokens, and breakpoints (`sm`, `md`, `lg`, `xl`, `2xl`). Light-first styling with dark-theme compatibility.

## H. Core Components
Expected component library suite (built on Radix primitives and Tailwind v4):
- **Navigation & Layout**: `Sidebar`, `PageHeader`, `Breadcrumb`, `Tabs`, `Sheet` (Drawer).
- **Form Controls**: `Button`, `IconButton`, `Input`, `Textarea`, `Select`, `Combobox`, `Checkbox`, `RadioGroup`, `FileUpload`, `StepWizard`.
- **Data Display & Feedback**: `Badge`, `Alert`, `Card`, `DataTable`, `Pagination`, `FilterBar`, `BulkActionBar`, `ValidationSummary`, `StatusTimeline`, `ActivityFeed`.
- **Overlay & Messaging**: `Dialog`, `AlertDialog`, `DropdownMenu`, `Tooltip`, `Toast`.
- **Loading & Fallbacks**: `Progress`, `Skeleton`, `EmptyState`, `ErrorState`.

Relevant views and operations must handle applicable Loading, Empty, Error, Disabled, and Permission-Denied states.

## I. Page Templates
1. **Overview Dashboard**: Metrics overview, pending review counts, recent import activities, system alerts.
2. **Collection / Index Page**: Resource table with search, filter toolbar, pagination, and bulk actions.
3. **Project Editor**: Primary editable content area with contextual right rail for status, validation errors, internal/public preview link, and audit history. Includes sticky action bar and unsaved-change protection. (Note: Do not render or promise a live Duda preview before approved Duda integration cutover).
4. **Import Wizard**: Multi-step package/folder selection, file inspection, spreadsheet reconciliation, and validation review.
5. **Import Result Page**: Batch outcome summary, successful records, error breakdown, and quick edit links.
6. **Internal / Public-Layout Preview Workspace**: Side-by-side rendered view comparing draft metadata against public display layout.
7. **Publication / History Page**: Release log, public feed payload preview, and controlled rollback interface.
8. **Settings & User Management Page**: Integration status, environment classification, configuration health, and user role management.

## J. Data-Table Standard
- Global text search across project metadata fields.
- Multi-faceted filter bar for status, program, discipline, and academic year.
- Column sorting with clear visual direction indicators.
- Server-side pagination with configurable page size options.
- Row selection checkboxes with select-all-on-page and bulk action bar invocation.
- Contextual row action dropdown menus (Edit, Duplicate, Archive, Preview).
- Loading skeleton, Empty data state, and Error retry states.
- Accessible keyboard operation and responsive list fallback for mobile viewports.
- URL-persisted search and filter parameters where appropriate.
- Scalable server-side querying rather than loading all records indefinitely into memory.

## K. Import-Wizard Standard
Core batch import workflow:
Select submission folder/package
→ Inspect files
→ Read `project-details.xlsx`
→ Reconcile spreadsheet and project metadata
→ Review validation issues
→ Confirm import
→ Show results and next actions

Note: Package intake may accept folders or archive files; ZIP support is optional and not the sole supported intake method.

## L. Publication & Rollback Governance
Controlled, authorized rollback workflow requires:
- Snapshot selection from publication history;
- Checksum or integrity verification;
- Authorization check;
- Selected versioned public-feed snapshot restoration;
- Fresh-feed retrieval and validation;
- Duda listing/detail verification when connected;
- Server-side audit attribution logging;
- Failure handling and recovery alerts.

Rollback refers specifically to selected versioned public-feed snapshot restoration, not generic database restoration or instant rollback.

## M. Security & Configuration UI
Settings and configuration views may display:
- External integration status (Supabase, Duda);
- Environment classification (Staging / Production);
- Configuration ownership and sync health.

Never display:
- API keys, access tokens, service-role secret values, database passwords, or secret environment contents.

## N. Accessibility & Quality Gates
WCAG 2.2 AA target requires automated and manual verification evidence:
- Semantic landmarks (`<main>`, `<nav>`, `<aside>`, `<header>`, `<footer>`);
- Keyboard navigation and focus indicator testing;
- Screen-reader label and description relationship verification;
- Color contrast verification (4.5:1 text, 3:1 graphical UI);
- Support for `prefers-reduced-motion`;
- Status communication using text labels + icons (no color-only status);
- Responsive layout verification at representative mobile, tablet, and desktop widths;
- Loading and failure-state testing;
- Visual regression or screenshot comparison at implementation PR gates.

Do not claim WCAG certification before empirical test evidence exists.

## O. Technology Decision
- Next.js App Router with TypeScript;
- Tailwind CSS v4 with semantic CSS-variable tokens;
- Locally owned `shadcn`-style components built on Radix primitives;
- TanStack Table v8;
- Lucide React icons;
- Native implementation without replacing the stack with another CMS platform.

## P. Phased Implementation Roadmap
1. **Styling Infrastructure & Primitives**: Setup Tailwind CSS v4, tokens, and Radix primitives.
2. **Authenticated Application Shell**: Implement responsive sidebar, top bar, breadcrumbs, and drawer.
3. **Operational Dashboard & Project Index**: Build project grid with TanStack Table, search, and filters.
4. **Project Editor**: Build form layout, contextual validation right rail, and unsaved-change protection.
5. **Import & XLSX Reconciliation**: Multi-step folder/spreadsheet import and validation workflow.
6. **Confirmation & Preview**: Student confirmation tracking and layout preview workspace.
7. **Publishing & Controlled Rollback**: Feed publishing trigger, snapshot history, and governed rollback.
8. **Accessibility & Visual QA**: Automated axe/Lighthouse sweeps, keyboard testing, visual regression.

Each phase must preserve existing authentication behavior and include explicit acceptance criteria.

## Q. References
- Next.js Documentation: https://nextjs.org/docs
- Tailwind CSS Documentation: https://tailwindcss.com/docs
- Radix Primitives: https://www.radix-ui.com/primitives
- TanStack Table: https://tanstack.com/table/v8
- W3C WCAG 2.2 Guidelines: https://www.w3.org/TR/WCAG22/
- Directus Documentation: https://docs.directus.io/
- Shopify Polaris Design System: https://polaris.shopify.com/
- Sanity Studio Documentation: https://www.sanity.io/docs
- Contentful Developer Center: https://www.contentful.com/developers/docs/
- Payload CMS Documentation: https://payloadcms.com/docs
- Atlassian Design System: https://atlassian.design/
