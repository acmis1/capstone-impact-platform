# Admin/CMS UI System & Architecture Contract

## A. Product Positioning
The Capstone Impact Platform Admin/CMS is an enterprise editorial operations platform designed specifically for non-technical school staff, course coordinators, and academic administrators. It is not a generic developer dashboard or database GUI. Its focus is efficient project curation, batch importing, confirmation tracking, metadata validation, and publishing governance.

## B. Industry Benchmark Synthesis
The UI system draws design patterns from established administrative platforms while maintaining RMIT brand identity:
- **Directus**: Module navigation, collection management, advanced filters, saved bookmarks, package importing, batch archiving, and detailed audit activity logs.
- **Shopify Admin**: High-density searchable/filterable/sortable/paginated resource tables, bulk selection actions, and sticky action headers.
- **Sanity**: Content-structure navigation, multi-pane editing, contextual right rails, and real-time validation feedback.
- **Contentful**: Structured field editing with publishing status tags, workflow tasks, and side-by-side preview panels.
- **Payload**: Collapsible application shell, high-performance long forms, version history, visual diff comparisons, and one-click rollback.
- **Atlassian Design System**: Grid discipline, standardized elevation/tokens, clear visual hierarchy, accessible primitives, and consistent micro-interactions.

## C. Design Principles
1. **Task-First Layouts**: Surface immediate operational actions without clutter.
2. **Clarity Before Decoration**: Functional visual hierarchy over decorative graphics.
3. **Progressive Disclosure**: Expose advanced parameters only when required.
4. **Dense But Readable**: High information density balanced with generous line height and clear typography.
5. **Keyboard-First Design**: Full keyboard accessibility for repetitive administrative operations.
6. **Accessibility by Construction**: Built atop accessible primitives matching WCAG 2.2 AA standards.
7. **Explicit System Status**: Unambiguous visual indicators for draft, review, ready, published, and archived states.
8. **Reversible Operations**: Provide safe undo/rollback mechanisms for critical editorial changes.
9. **Auditability**: Track all status shifts, edits, and publishing events with explicit user attribution.
10. **Consistent Terminology**: Standardized terminology across navigation, notifications, and modals.
11. **Responsive Without Hiding Actions**: Adapt layouts across viewports without omitting critical tools.
12. **Restrained Motion**: Subtle, functional animations respecting `prefers-reduced-motion`.
13. **No Dark-Pattern Confirmations**: Clear, explicit dialogs for destructive actions without misleading copy.

## D. Information Architecture
Target application navigation (future routes marked as planned):

- **Overview** (Planned)
- **Projects**
  - All Projects (Current Prototype Baseline)
  - Needs Review (Planned)
  - Ready to Publish (Planned)
  - Archived (Planned)
- **Imports**
  - New Import (Planned)
  - Import History (Planned)
  - Validation Issues (Planned)
- **Confirmations**
  - Awaiting Response (Planned)
  - Correction Requests (Planned)
  - Completed (Planned)
- **Publishing**
  - Ready to Publish (Planned)
  - Publication History (Planned)
  - Removal Queue (Planned)
  - Rollback (Planned)
- **Administration**
  - Users and Roles (Planned)
  - Programs and Categories (Planned)
  - Audit Log (Planned)
  - System Health (Planned)

## E. Application Shell
- **Desktop Sidebar**: Collapsible navigation rail containing branded header, grouped module links, status counters, and collapse toggle.
- **Mobile Navigation Drawer**: Slide-out overlay drawer providing complete navigation access on narrow screens.
- **Compact Top Bar**: Persistent top header with breadcrumb trail, global search input, environment indicator (Staging/Production), notifications menu, and user profile dropdown.
- **Breadcrumbs**: Explicit hierarchy navigation path.
- **Page Header**: Contextual title, subtitle, and primary page-level actions.
- **Skip-to-Content Link**: Keyboard accessible landmark jumping directly to `#main-content`.
- **Global Status Area**: Floating toast notifications and persistent system status banners.

## F. Design-Token Direction
Light-first design token structure with dark-theme compatibility:
- **Brand Tokens**: RMIT Red (`var(--color-brand-primary)` used deliberately for identity accents, active states, and primary focal points), Slate Navy (`var(--color-brand-secondary)`).
- **Background & Surfaces**: Base background, surface elevated, surface inset, surface overlay.
- **Text**: Primary, secondary, muted, inverse, brand-accent.
- **Borders & Focus**: Subtle border, strong border, interactive focus ring (`2px solid var(--color-focus-ring)`).
- **Action Semantics**: Primary action, secondary action, ghost action, danger action.
- **Feedback Semantics**: Success (Green), Warning (Amber), Critical (Red), Information (Blue).
- **Spacing & Radius**: 4px baseline scale (`space-1` to `space-16`), radius values (`sm: 4px`, `md: 6px`, `lg: 8px`, `full: 9999px`).
- **Typography & Breakpoints**: System font stack / Inter; breakpoints at `sm: 640px`, `md: 768px`, `lg: 1024px`, `xl: 1280px`, `2xl: 1536px`.

## G. Core Components
Expected component library suite (built on Radix primitives and Tailwind v4):
- **Navigation & Layout**: `Sidebar`, `PageHeader`, `Breadcrumb`, `Tabs`, `Drawer/Sheet`.
- **Form Controls**: `Button`, `IconButton`, `Input`, `Textarea`, `Select/Combobox`, `Checkbox`, `RadioGroup`, `FileUpload`, `StepWizard`.
- **Data Display & Feedback**: `Badge`, `Alert`, `Card`, `DataTable`, `Pagination`, `FilterBar`, `BulkActionBar`, `ValidationSummary`, `StatusTimeline`, `ActivityFeed`.
- **Overlay & Messaging**: `Dialog`, `AlertDialog`, `DropdownMenu`, `Tooltip`, `Toast`.
- **Loading & Fallbacks**: `Progress`, `Skeleton`, `EmptyState`, `ErrorState`.

### Detailed Component Specifications
- **Button**: Supports `primary`, `secondary`, `ghost`, and `destructive` variants. Handles loading spinner state and disabled attributes.
- **DataTable**: Built on TanStack Table v8. Includes search input, multi-select checkboxes, column sorting headers, and sticky pagination footer.
- **Dialog & AlertDialog**: Focus-trapped overlay modals with accessible title/description bindings (`aria-labelledby`). AlertDialog provides strong visual confirmation for destructive changes.
- **Drawer / Sheet**: Slide-over panel for secondary tasks, detailed row inspection, or mobile navigation.
- **ValidationSummary**: Accessible error alert container highlighting input validation errors with direct jump links to invalid fields.

## H. Page Templates
1. **Overview Dashboard**: Metrics overview, pending review counts, recent import activities, system alerts.
2. **Collection / Index Page**: Resource table with search, filter toolbar, pagination, and bulk actions.
3. **Project Editor**: Primary editable content area with contextual right rail for status, validation errors, Duda preview link, and audit history. Sticky save/review actions header.
4. **Import Wizard**: Multi-step package selection, file inspection, spreadsheet reconciliation, and validation review.
5. **Import Result Page**: Batch outcome summary, successful records, error breakdown, and quick edit links.
6. **Preview Workspace**: Side-by-side rendered public view vs draft metadata inspection.
7. **Publication / History Page**: Release log, public feed payload preview, and instant rollback controls.
8. **Settings & User Management Page**: Role assignments, system configuration, and integration access keys.

### Layout Specifications for Project Editor
- **Main Column (65% Width)**: Includes metadata inputs, student team roster, abstract text, poster image preview, and downloadable document links.
- **Contextual Right Rail (35% Width)**: Features publishing workflow status badge, automated validation checklist, live Duda preview link button, and recent audit activity timeline.
- **Sticky Footer Action Bar**: Contains Cancel, Save Draft, Submit for Review, and Publish buttons with unsaved changes warnings.

## I. Data-Table Standard
- Global text search across title, student name, supervisor, and project ID.
- Multi-faceted filter bar for status, program, discipline, and academic year.
- Column sorting with clear visual direction indicators.
- Server-side pagination with configurable page size options.
- Row selection checkboxes with select-all-on-page and bulk action bar invocation.
- Contextual row action dropdown menus (Edit, Duplicate, Archive, Preview).
- Integrated Loading skeleton, Empty data state, and Error retry states.
- Responsive list fallback for mobile viewports.
- URL-persisted search and filter parameters for bookmarkable collection views.
- Scalable server-side querying rather than loading all records indefinitely into memory.

## J. Import-Wizard Standard
Structured multi-step workflow for batch student submissions:
1. **Select Package**: Upload `.zip` package or select staged server package.
2. **Inspect Files**: Automated parsing of ZIP archive structure and media assets.
3. **Reconcile Spreadsheet**: Map spreadsheet columns to database schema attributes.
4. **Review Validation Issues**: Highlight missing required fields, invalid emails, or missing images.
5. **Confirm Import**: Display batch summary and execute database transaction upon user confirmation.
6. **Result & Next Actions**: Summary report with links to review imported draft projects.

## K. Accessibility & Quality Gates
- **WCAG Target**: Full compliance with WCAG 2.2 AA standards.
- **Landmarks & Semantics**: Proper `<main>`, `<nav>`, `<aside>`, `<header>`, and `<footer>` HTML tags.
- **Keyboard Operability**: Full accessibility using `Tab`, `Arrow` keys, `Escape`, and `Enter`/`Space`.
- **Visual Indicators**: High-contrast focus rings (`:focus-visible`), colorblind-safe status badges with accompanying text icons.
- **Screen Reader Support**: Accessible `aria-` attributes (`aria-expanded`, `aria-controls`, `aria-live`).
- **Contrast & Motion**: Verified contrast ratios (4.5:1 text, 3:1 UI components) and reduced-motion support.
- **No Colour-Only Communication**: Status indicator badges must combine text labels, icons, and contrast-compliant colors.
- **Responsive & Failure Checks**: Responsive checks across mobile, tablet, desktop; loading and failure state tests required.

## L. Technology Decision
- **Styling**: Tailwind CSS v4 with CSS variables for design tokens.
- **Component Architecture**: Locally owned `shadcn`-style TypeScript components based on Radix UI primitives.
- **Data Tables**: TanStack Table v8 for robust, headless table state management.
- **Icons**: Lucide React icon library (no emojis as UI icons).
- **Scope Limit**: No adoption of monolithic external CMS platforms; native Next.js App Router implementation.
- **Dependency Policy**: No dependencies installed in this documentation PR; packages added only in implementation PRs.

## M. Phased Implementation Roadmap
- **Phase 1: Styling Infrastructure & Primitives**: Setup Tailwind CSS v4, design tokens, and core Radix component primitives.
- **Phase 2: Application Shell**: Build responsive desktop sidebar, top header, breadcrumbs, and mobile navigation drawer.
- **Phase 3: Dashboard & Project Index**: Implement TanStack Table project list with search, filtering, and pagination.
- **Phase 4: Project Editor**: Build project form layout with sticky action header and contextual validation rail.
- **Phase 5: Import Wizard**: Implement multi-step package import and reconciliation workflow.
- **Phase 6: Confirmation & Preview**: Develop student confirmation tracking and side-by-side Duda preview workspace.
- **Phase 7: Publishing & History**: Build publishing trigger interface, public feed generator, and rollback manager.
- **Phase 8: Accessibility & Visual QA**: Conduct automated axe/Lighthouse audits, keyboard navigation sweeps, and screen reader verification.

Each phase must preserve existing authentication behavior and include explicit acceptance criteria.
