# Final Showcase Design Analysis and Improvement Proposal

**Document ID**: `DOC-MG01-SHOWCASE-DESIGN-PROPOSAL-20260912`
**Milestone Gate**: **MG-01** (Capstone Project Showcase design analysis and improvement proposal)
**Authoritative reference**: the Project Brief (`Capstone Brief.txt`, held outside Git at the workspace root)
**Repository**: `acmis1/capstone-impact-platform`
**Branch**: `docs/brief-design-analysis-20260912`
**Base commit**: `d6cd337f4e6dc071dd864b99553c3f9af6b634ce`
**Scope**: documentation and design proposal only. No application code was modified, no live Duda site was browsed or published, and voting is out of scope.

---

## 1. Purpose and brief requirement

The Project Brief has two objectives. This document closes the first one:

> "To develop an approach proposal that analyses and improves the design, layout, and content structure of the existing Capstone Project Showcase webpage, while working within the constraints of a third-party platform."

The brief's deliverable list states the shape of that proposal:

> "A design analysis and improvement proposal for the existing Capstone Project Showcase webpage, including: Review of current layout, navigation, content hierarchy, and usability; Recommendations to improve clarity, accessibility, discoverability, and visual impact."

Related brief requirements that this document references as evidence, but does not itself close, are:

- "Search and filtering by discipline, industry, year, and program";
- "handle high-volume content (100+ projects per year)";
- "Each project page must include full text versions of all image content for accessibility and search optimisation";
- support for "multiple academic programs (IT, Engineering, Aviation, Food Tech, and future programs)";
- "ensure accessibility compliance".

Voting ("An optional voting system") is excluded from this milestone by project directive.

This document does not claim that a single design document proves every Project Brief requirement. Its traceability (Section 11) is limited to layout, navigation, content hierarchy, usability, clarity, accessibility recommendations, discoverability, visual impact, and third-party (Duda) constraints.

---

## 2. Evidence reviewed

Every claim in this document is bound to one of the following sources. Anything that could not be bound was removed.

### 2.1 Project Brief

`Capstone Brief.txt` (workspace root, outside Git). Quoted in Section 1.

### 2.2 Historical audit files (external project evidence, April 2026)

These files live **outside Git** at `D:\IT RMIT\Capstone\Capstone Impact Project Analysis\`. They are not repository files, were not copied into the repository, and there is no `docs/audits/` directory in the repository. The files consulted directly for this document are:

| File | Date / scope | What it records |
| :--- | :--- | :--- |
| `website_audit.md` | 2026-04-09, live `rmitvn-showcase.com/vi` | Navigation structure, page types, usability/accessibility observations, inferred maintenance workflow |
| `duda_pages_cms_audit.md` | Duda editor, page tree and CMS collections | Page tree, SSET hidden-subpage model, legacy project collection at 10/10 |
| `duda_backend_audit.md` | Duda editor backend | 70+ project-specific entities (popups and hidden subpages), Filestack media manager, empty form-responses dashboard, site-audit findings |
| `duda_workflow_ops_audit.md` | Duda editor operations | Meta-tag and alt-text site-audit issues, native EN/VI multi-language with manual content sync |
| `duda_sset_constraints_findings.md` | SSET operational constraints | Manual page creation, manual linking matrix, EN/VI double maintenance, intake gap |
| `duda_scalability_final_report.md` | 2026-04-13, site `c5bc8c6b` | One internal collection with a 10-item limit in the inspected plan; External Collections option missing; Options A/B/C |
| `template_variation_matrix.md` | Cross-school comparison | Listing and detail-page field presence per school |
| `duda_brief_fit_analysis.md`, `duda_capability_summary.md` | Early proposal stage | The Google Form → Google Sheet → Duda External Collection concept and its assumptions |
| `duda_env_confirmation.json` | 2026-04-25 | Inspected environment was `testwww-rmitvn-showcase-comsset` (a test site, not published) |
| `url_inventory.md` | Live-site URL sample | School hub, program hub, listing, and example detail URLs |

Observations in those files are quoted or paraphrased as **observed**; their inferences are labelled **inferred**.

### 2.3 Current repository source at `d6cd337`

Verified paths (all exist in the worktree):

- `apps/admin-cms/package.json` — Admin/CMS dependencies (`next` `16.3.4`, `react` `19.2.4`).
- `apps/admin-cms/src/auth/authTypes.ts`, `apps/admin-cms/src/auth/permissions.ts` — provisioned staff roles `admin | reviewer | editor`.
- `apps/admin-cms/src/assistive-validation/` — assistive (non-authoritative) validation services.
- `apps/public-layer/duda/bodyend.html` — the public runtime (feed fetch, validation, listing, detail presets, lightbox).
- `apps/public-layer/duda/listing-page.html`, `apps/public-layer/duda/listing-page.css` — listing host shell and stylesheet.
- `apps/public-layer/duda/detail-page.html`, `apps/public-layer/duda/detail-page.css` — detail host shell and stylesheet.
- `apps/public-layer/duda/current-feed-demo-fixture.json`, `apps/public-layer/duda/current-feed-contract-cases.json` — synthetic fixtures used by the executable checks.
- `apps/public-layer/scripts/test-duda-feed-url-validator.js`, `apps/public-layer/scripts/test-duda-current-feed-browser.js`, `apps/public-layer/scripts/test-duda-annual-scale-browser.js` — the public-layer executable checks (`npm run test:public-layer`).
- `docs/public-feed-contract.md` — public feed shape and caching contract.
- `docs/duda-annual-scale-rendering-evidence.md` — the 120-record local rendering evidence design.
- `docs/duda-integration-plan.md`, `docs/implementation-backlog.md` — integration plan and current backlog.
- `docs/participant-owned-corrections-handoff.md`, `docs/project-details-workbook-contract.md`, `docs/admin-operator-guide.md` — participant correction, intake workbook, and staff operating contracts.
- `docs/accessibility-uat-evidence/` — Admin/CMS accessibility evidence, which itself states it is "neither WCAG certification nor public showcase/Duda acceptance".

### 2.4 Executable and browser evidence

- `npm run test:public-layer` executed on this branch during this review (Section 9.1).
- Twenty local headless-Chromium screenshots captured on 2026-09-12 against the repository public layer with synthetic fixture data, held **outside Git** at `D:\IT RMIT\Capstone.rollout\continuation-20260910\mg01-design-evidence-20260912\` with a `scenario_summary.json` index (Section 9.2). The ad-hoc capture scripts that produced them were not retained in the repository or in the evidence directory.

**No live Duda browsing, editing, or publishing occurred in this MG-01 task.** All browser evidence in this document is `LOCAL SYNTHETIC / FIXTURE BROWSER OBSERVATION`. Where the April 2026 audit files describe the live site or Duda editor, that is labelled `HISTORICAL LIVE DUDA OBSERVATION (APRIL 2026)`.

---

## 3. Analysis of the current (historical) showcase

All statements in this section are `HISTORICAL LIVE DUDA OBSERVATION (APRIL 2026)` unless marked **inferred**.

### 3.1 Navigation and discoverability

Observed (`website_audit.md` §2, §6):

- Main navigation is a **Schools dropdown** (Business, SCD, SST) with per-school specialisation sub-categories, an EN/VI language switcher, and a prominent homepage search bar.
- "Hover-based menus are difficult to use on mobile and can be brittle on desktop."
- "Some listings are buried deep in menus; search is the most powerful discoverability tool but results are just cards."
- Project listings "use grids, grouped sections, and navigation structures, with limited visible listing-level filtering."

Observed (`url_inventory.md`): some example detail-page URLs were recorded as "unresolved / search-dependent sample" or "URL not static/directly indexed". This is a sampled observation, not a claim that every project lacks a stable URL.

Observed (`duda_pages_cms_audit.md`, `duda_backend_audit.md`): SSET projects are individual hidden subpages nested under a "School Projects" parent, hidden from navigation and manually linked; SCD uses popups extensively; the inspected site holds "over 70 project-specific entities" across popups and hidden subpages.

**Inferred** (`website_audit.md` §7): "Significant variation in layouts per program suggests a manual editing process rather than template generation from a structured database." Project information "appears to be siloed within individual pages".

Not supported by the historical sources, and therefore not claimed here: measured click-depth statistics, recruiter drop-off, or a universal absence of stable deep-link URLs.

### 3.2 Layout and content hierarchy

Observed (`website_audit.md` §3–§5, `template_variation_matrix.md`):

- Page types are homepage, school/program hubs, project listings, and project detail pages.
- Detail pages are "narrative-driven (Design) or document-driven (Business)". Business pages often act "as a wrapper for PDF projects"; SST pages focus on "technical abstracts and formal reports"; SCD pages are "media-rich and narrative-driven".
- Field presence is inconsistent across schools: course code, year/date, tags/categories, and filter/sort are marked "No", "Inconsistent", or "Variable" in most cells of the matrix; no school listing has embedded filter/sort.
- Bilingual content is delivered as tabs/accordions within a single page.
- "Text contrast is generally good, but hierarchy can be confusing in document-heavy pages."

### 3.3 Usability

Observed:

- Hover menus (above) are a mobile usability problem.
- Bilingual delivery through in-page tabs rather than separate language paths.
- Listing-level filtering is limited; search returns card results only.

**Inferred** (`website_audit.md` §7, `duda_sset_constraints_findings.md`): manual formatting and PDF-heavy updates present "potential overhead risks for long-term growth and metadata consistency"; EN/VI content sync for hidden subpages is "a purely manual task" with a high drift risk.

### 3.4 Accessibility

Observed:

- "Alt-text quality was not consistently verifiable from the visual audit and should be tested formally." (`website_audit.md` §6)
- "Heavy reliance on embedded PDFs likely creates accessibility and searchability drawbacks compared with native HTML content." (`website_audit.md` §6)
- Duda's own site audit reported "Image Alt Text: 1 high-priority issue" and "Page Meta Tags: 2 high-priority issues" for the inspected test site (`duda_backend_audit.md`, `duda_workflow_ops_audit.md`).

**Inferred** (`duda_workflow_ops_audit.md`): manual project creation "increases the risk of missing alt-text and duplicate meta-tags, as there is no central CMS template to enforce these fields."

Not supported, and not claimed: "total screen-reader failure", specific alt-text failure rates, or any measured accessibility score.

### 3.5 Third-party (Duda) platform constraints

Observed (`duda_pages_cms_audit.md`, `duda_backend_audit.md`, `duda_scalability_final_report.md`), all against the inspected test environment `testwww-rmitvn-showcase-comsset` (site `c5bc8c6b`, April 2026):

- The inspected internal project collection showed **10/10** items.
- The "External Collection" option (Google Sheets / Airtable) was **missing** from the "Add Collection" menu in that environment.
- The "Project Page" dynamic template existed but was bound to the 10-item internal collection.
- The Form Responses dashboard was empty; no automated intake existed.
- Header/footer HTML injection points were accessible ("Automation Ready").
- The report's recommended paths were: (A) plan upgrade for External Collections, (B) a custom HTML/JavaScript widget fetching from an external data source, or (C) status quo.

The April report's own wording is "likely Basic or Team" for the plan level. This document therefore does **not** claim a universal Duda hard cap of 10, a specific commercial tier name, an upgrade price, or an "unlimited" architecture. The retained statement is:

> The retained public renderer avoids dependence on a Duda subscription upgrade for project-record storage/rendering, based on the April 2026 inspected environment.

Not supported, and not claimed: Duda-editor freezes, page-weight figures, or Lighthouse scores for the historical site.

### 3.6 Operational workflow (context from the Project Brief)

The brief itself states the operational problem: "one staff member requires at least two weeks to process, verify, and publish a batch of capstone projects, with extensive manual checking and formatting." The April audits corroborate the manual 1:1 project-to-page model and the absence of an intake pipeline. Specific claims about historical form submissions (broken links, capitalisation, unvetted drafts going live) are not in the audit files and are not made here.

---

## 4. Architecture evolution

### 4.1 The early Google Form → Sheet → Duda External Collection concept

`duda_brief_fit_analysis.md` and `duda_capability_summary.md` record the early recommendation: an external form feeding a Google Sheet, connected to Duda as an External Collection and rendered through a Duda dynamic page template. `duda_scalability_final_report.md` (2026-04-13) then found the External Collection option absent in the inspected environment, making that path dependent on a plan change (its Option A).

The reasons the project moved away from that concept, as far as the evidence supports them:

1. **Platform dependency** (observed): the External Collection option was missing in the inspected environment.
2. **No validation or approval gate** (from the Project Brief's requirements): the brief requires content validation rules, AI-assisted checks, an admin CMS, and a preview/confirmation workflow — none of which a sheet-to-Duda sync provides.
3. **Privacy** (design judgement, not audit evidence): a spreadsheet as the system of record would hold unpublished participant content without an access model.

The April report's Option B — "a custom HTML/JavaScript widget that fetches data" from an external source — is the lineage of the current public layer.

### 4.2 The current architecture at `d6cd337`

Two tiers, joined by one published JSON file. All statements below are from repository source.

**Tier 1 — School-owned Admin/CMS** (`apps/admin-cms/`, Next.js `16.3.4`, React `19.2.4`, Supabase Postgres/Auth/Storage):

- Provisioned **staff roles** only: `admin`, `reviewer`, `editor` (`apps/admin-cms/src/auth/authTypes.ts`). There is no participant portal, supervisor portal, or program-admin portal, and no single-sign-on path for participants.
- Participant / project-team content enters through **package, form, and correction workflows** (`docs/participant-owned-corrections-handoff.md`, `docs/project-details-workbook-contract.md`). Participants receive **secure participant previews**; they are not Admin/CMS roles.
- Review is the existing reviewer workflow (approve / request changes / archive) operated by staff (`docs/admin-operator-guide.md`). There is no supervisor-approval or dean-approval stage in the source.
- **OCR / AI-assisted validation is assistive and non-authoritative.** It produces findings for staff; it does not author published content. The project team / participant authors the final public text, including the full text of text-bearing gallery images; the accepted source or correction package remains the publication authority.
- Publication compiles public-eligible records into `capstones-latest.json` through a single server-side writer (`docs/public-feed-contract.md`: `PublicFeedStorageBoundary` "is the only production path permitted to replace `capstones-latest.json`").

**Public feed** (`docs/public-feed-contract.md`, `apps/public-layer/duda/bodyend.html`):

- One file, `capstones-latest.json`, in a Supabase public Storage bucket.
- `bodyend.html` fetches the single configured `window.CAPSTONE_FEED_URL` (validated to an `https` Supabase-shaped path), appends a `?v=<timestamp>` cache-busting query, and requests with `cache: "no-store"`.
- There is **no** client-side feed cache, **no** per-year feed file, **no** feed switching from the Year facet, and **no** CDN or static-hosting layer in the source. Archiving is a project-status concept in the Admin/CMS (`archived`, `archivedAt`, removal from the public feed), not a partitioned public feed. The only client-side storage use is `localStorage.selectedProjectId` as a fallback for the detail route.

**Tier 2 — Public layer inside Duda** (`apps/public-layer/duda/`):

- `listing-page.html` is a minimal shell: `<div id="capstone-showcase-root"><div id="capstone-project-grid"></div></div>`.
- `detail-page.html` is a minimal shell: `<div id="project-detail"></div>`.
- `bodyend.html` is injected once (Duda body-end HTML). It detects which shell is present, fetches and validates the feed, and renders either the listing (search input, four `<select>` facets — Year, Program, Discipline, Industry Sector — and year-grouped card sections) or the detail view (one of three layout presets: `poster_showcase`, `technical_detail`, `media_rich`, selected from the record's `layoutConfig.templateId` with `poster_showcase` as default).
- Detail routing is `/project-detail?id=<numeric id>`.
- Text-bearing images carry `{ contentKind: "text_bearing", fullText }` and render a native `<details>` disclosure ("Read full text of image N" / "Read full poster text") plus the same text in the lightbox.
- The lightbox is a `role="dialog"` `aria-modal="true"` element with an accessible name, close/previous/next buttons with accessible names, initial focus on Close, Tab/Shift+Tab containment, Escape to close, arrow-key navigation, body scroll lock, and focus restoration to the opener.
- `listing-page.css` and `detail-page.css` use a dark slate palette (`#0f172a` background, `#f8fafc` text, `#94a3b8` secondary text) with red accent buttons; focus outlines are `3px solid rgba(255,255,255,0.85)` on listing controls and `3px solid currentColor` in the detail stylesheet. These are **not** institutional brand tokens; see Recommendation R-7.

The three-record demo fixture, the `current-feed-contract-cases.json` cases, and the 120-record generated fixture are all synthetic.

### 4.3 Comparison

| Dimension | Historical showcase (April 2026 observation) | Early concept (Form → Sheet → Duda External Collection) | Current architecture (`d6cd337`) |
| :--- | :--- | :--- | :--- |
| Duda dependency for records | Manual pages/popups; internal collection at 10/10 | External Collection option (missing in inspected environment) | Duda hosts two shells and one injected script; records live in the published feed |
| Intake | Manual, no form pipeline observed | Google Form | Package / form / correction workflows into the Admin/CMS (MG-02 accepted locally) |
| Review | None observed in Duda | None | Staff `admin`/`reviewer`/`editor` roles; approve / request changes / archive |
| Full text for images | Not verifiable; PDF-heavy | Not addressed | Project-team-authored `fullText` on text-bearing images; native `<details>` disclosures (MG-05 accepted locally) |
| Public facets | Menus; limited listing filters | Not addressed | Year, Program, Discipline, Industry Sector selects |
| Scale evidence | Not measured | Not measured | 120-record local browser harness passes (Section 9.1) |

---

## 5. Duda constraints the proposal operates within

Sourced from the April audits and the current integration plan (`docs/duda-integration-plan.md`):

1. Project records are **not** stored in a Duda collection; they arrive via the published feed. This removes the dependence on the 10-item internal collection observed in the inspected environment.
2. The public layer uses only Duda's HTML embed / body-end injection points, which the April backend audit observed as accessible.
3. No Duda plugin, app-store widget, or plan feature beyond HTML injection is assumed.
4. The renderer is plain browser JavaScript and CSS with no runtime library; generated classes are prefixed (`capstone-*`, `cip-*`, `layout-preset-*`) and rendering is confined to the two shell containers. Whether this is sufficient to avoid style interaction with a particular Duda theme is a **hosted staging** question that has not been tested (Section 12).
5. Two Duda pages are required: a listing page and a detail page, each carrying its shell markup.
6. Live Duda rendering, search-engine indexing of injected content, Duda's own analytics/cookie behaviour, and mobile behaviour inside the Duda theme are **not** evidenced by anything in this document.

---

## 6. Final improvement recommendations

Each recommendation carries one of four statuses:

- **IMPLEMENTED AND LOCALLY TESTED** — present in `d6cd337` source and exercised by `npm run test:public-layer` or the local screenshots.
- **IMPLEMENTED BUT HOSTED/HUMAN ACCEPTANCE PENDING** — present in source, but only provable on a hosted staging Duda site or by human UAT.
- **RECOMMENDED / INSTITUTIONAL** — a design recommendation requiring a decision or work that is not in `d6cd337`.
- **NOT REQUIRED** — considered and deliberately not proposed.

### 6.1 Navigation and discoverability

| ID | Recommendation | Status |
| :--- | :--- | :--- |
| R-1 | Replace school → specialisation → subpage traversal with one listing page that filters in place by Year, Program, Discipline, and Industry Sector. | IMPLEMENTED AND LOCALLY TESTED (four `<select>` facets in `bodyend.html`; facet and intersection cases in both browser harnesses) |
| R-2 | Give every project a stable, shareable detail URL (`/project-detail?id=<id>`). | IMPLEMENTED AND LOCALLY TESTED (routing and "card navigation preserves the selected numeric id" checks); live-host URL behaviour pending |
| R-3 | Make text search cover title, public ID, industry partner, team name, and the full text of text-bearing images, so poster content is discoverable. | IMPLEMENTED AND LOCALLY TESTED ("approved gallery full text participates in public search") |
| R-4 | Encode facet and search state in the URL so filtered views can be bookmarked and shared. | RECOMMENDED / INSTITUTIONAL — not implemented; `bodyend.html` keeps filter state in memory only |
| R-5 | Add a visible result count and a one-action "clear filters" control. | RECOMMENDED — not implemented; the current empty state is a text message ("No projects match the current search or filters.") without a reset control |
| R-6 | Provide "active filter" chips and per-option facet counts. | NOT REQUIRED for MG-01; optional refinement once R-5 is decided |

### 6.2 Layout and content hierarchy

| ID | Recommendation | Status |
| :--- | :--- | :--- |
| R-7 | Adopt the School's brand tokens (colour, type) in the public stylesheets. The current palette is a dark slate theme with red accents chosen for the local renderer, not an approved institutional design-system mapping. | RECOMMENDED / INSTITUTIONAL — requires brand input |
| R-8 | Use three detail presets so poster-led, technical, and media-led projects each get an appropriate hierarchy: `poster_showcase` (poster/PDF and snapshots first), `technical_detail` (abstract, sidebar media, team and citations emphasised), `media_rich` (featured hero media, links consumed into the hero region). | IMPLEMENTED AND LOCALLY TESTED (`layout-preset-*` branches; "*_preset renders" and "navigated record renders its configured detail preset" checks) |
| R-9 | Keep one H1 per detail page with a consistent heading sequence beneath it. | IMPLEMENTED AND LOCALLY TESTED ("renderer has exactly one project H1"; "heading sequence starts with the project H1") |
| R-10 | Group the listing by year with a section heading per year so cohorts read as cohorts. | IMPLEMENTED AND LOCALLY TESTED (year sections observed in `01_main_listing_desktop.png`) |
| R-11 | Keep the mobile order: return link → title and metadata chips → abstract → primary action → gallery → disclosures → narrative sections → team → resources. | IMPLEMENTED BUT HOSTED/HUMAN ACCEPTANCE PENDING — order observed in `15_mobile_navigation_order.png`; see the 390 px clipping note in Section 9.2 |

### 6.3 Usability

| ID | Recommendation | Status |
| :--- | :--- | :--- |
| R-12 | Render bounded, non-technical error and empty states rather than a blank page when the feed is missing, malformed, or empty. | IMPLEMENTED AND LOCALLY TESTED ("renders a bounded unavailable state", "empty feed renders a bounded empty state") |
| R-13 | Tolerate a partially bad feed: drop only structurally unusable records and unsafe optional links, keep the rest visible. | IMPLEMENTED AND LOCALLY TESTED (mixed-feed-availability and unsafe-record scenarios) |
| R-14 | Open external links safely (`target="_blank"` with `rel="noopener noreferrer"`), and reject non-`https`/unsafe URL schemes before rendering. | IMPLEMENTED AND LOCALLY TESTED (URL validator: 2 accepted / 16 rejected; link checks) |
| R-15 | Human usability testing with the School's actual audiences (industry partners, prospective applicants, staff). | RECOMMENDED / INSTITUTIONAL — not performed |

### 6.4 Accessibility

| ID | Recommendation | Status |
| :--- | :--- | :--- |
| R-16 | Every text-bearing image carries a concise `altText` **and** a project-team-authored full-text equivalent, rendered as selectable HTML text in a native `<details>` disclosure and inside the lightbox. | IMPLEMENTED AND LOCALLY TESTED ("poster full text uses a native details disclosure", "gallery full text is rendered as exact selectable HTML text", "gallery full text is not hidden from assistive technology") |
| R-17 | Ordinary (non-text-bearing) images carry alt text only; the renderer must not invent full text. | IMPLEMENTED AND LOCALLY TESTED ("lightbox removes full text for the ordinary second image") |
| R-18 | Lightbox as an accessible modal: dialog semantics, accessible names, focus containment, Escape, focus restoration. | IMPLEMENTED AND LOCALLY TESTED (dialog/modal/name checks, Tab and Shift+Tab wrap, "Escape restores focus to the exact snapshot opener") |
| R-19 | Visible focus indicators on interactive controls. | IMPLEMENTED (3 px outlines in both stylesheets) BUT HUMAN ACCEPTANCE PENDING — not exercised by an executable check |
| R-20 | Native screen-reader (NVDA/JAWS/VoiceOver), keyboard-only, and 200 %–400 % zoom user acceptance testing of the public pages. | RECOMMENDED / INSTITUTIONAL — **not performed**; no native assistive-technology UAT has occurred |
| R-21 | Formal WCAG conformance assessment by a qualified assessor before institutional launch. | RECOMMENDED / INSTITUTIONAL — this document makes **no** WCAG conformance claim |

### 6.5 Visual impact

| ID | Recommendation | Status |
| :--- | :--- | :--- |
| R-22 | Poster-led hero with a prominent "Download Poster PDF" action and a snapshot gallery beneath. | IMPLEMENTED AND LOCALLY TESTED (`poster_showcase`; PDF link and poster checks) |
| R-23 | Featured hero media (video or gallery) for media-led projects. | IMPLEMENTED AND LOCALLY TESTED (`media_rich`; featured hero lightbox checks; MP4 native player and generic-video fallback) |
| R-24 | Brand-approved imagery, typography, and colour. | RECOMMENDED / INSTITUTIONAL (see R-7) |
| R-25 | Animated transitions, carousels, or auto-play hero media. | NOT REQUIRED — not proposed; motion should be an accessibility-reviewed decision |

### 6.6 Third-party constraints

| ID | Recommendation | Status |
| :--- | :--- | :--- |
| R-26 | Keep project records out of Duda collections; render from the published feed via body-end injection and two shell pages. | IMPLEMENTED AND LOCALLY TESTED (harness loads the actual `bodyend.html`, shells, and stylesheets) BUT HOSTED ACCEPTANCE PENDING |
| R-27 | Prefix all generated classes and confine rendering to the shell containers to limit interaction with the Duda theme. | IMPLEMENTED BUT HOSTED ACCEPTANCE PENDING — theme interaction can only be verified on a staging Duda site |
| R-28 | Decide whether a Duda plan change is wanted for any reason other than record storage (e.g., search-engine treatment of dynamic pages). | RECOMMENDED / INSTITUTIONAL |

---

## 7. Layout and content hierarchy specification

The following describes what `bodyend.html` renders at `d6cd337`. Section names are the renderer's own.

### 7.1 Listing page

1. Controls row: `Search projects` text input (`maxlength="100"`, placeholder "Search by title, project ID, partner, or team"), then four labelled selects: Year, Program, Discipline, Industry Sector. Each select lists `All` plus the distinct values present in the feed (years descending, the others alphabetical).
2. One section per year, headed "`<year>` Projects", containing a card grid.
3. Each card: poster image (alt = project title) as a click target, and a "Learn more" action; both navigate to `/project-detail?id=<id>`.
4. Empty state: a single centred paragraph.
5. Error state: an inline bounded error block with a public reason code; no exception text is exposed.

### 7.2 Detail page

Common top: "← Return to Showcase" link, a "Capstone Exhibition" label, the project H1, metadata chips (program, "Class of `<year>`", disciplines, industry partner, supervisor), an abstract block, and the primary action.

- **`poster_showcase`**: poster (or poster PDF action) is the primary asset; a snapshot strip follows when snapshots exist; each text-bearing snapshot and the poster expose a `<details>` disclosure; narrative sections (Background, The Solution, …) then Team then Resources.
- **`technical_detail`**: abstract-led; sidebar media (poster/PDF/snapshots) alongside the narrative; Team and Citations rendered in their technical variants.
- **`media_rich`**: featured hero media (video or gallery) first; the `links` / `externalLinks` sections are consumed into the hero region; remaining sections follow.

Section visibility and order can be constrained per record through `layoutConfig` (hidden sections, section order, featured media), with omission handled by the `contract-*-omitted` cases.

### 7.3 Mobile (390 px)

The controls stack vertically; year sections and cards reflow to one column; the detail layout collapses to a single column in the order listed in R-11. The executable harnesses assert no horizontal document overflow at 390 px for the listing, the three preset detail pages, and the position-two-and-five gallery case. See Section 9.2 for a screenshot discrepancy that still needs re-checking.

---

## 8. Navigation and discoverability model

- **Entry**: one listing page. No school or specialisation sub-pages are required for discovery.
- **Filter**: four independent facets, intersected with each other and with the search string on every change (`handleFilterChange`, `handleSearchChange`); rendering is synchronous with no debounce.
- **Search fields** (`bodyend.html`, listing filter): title, `publicId`, `industryPartner`, `groupName`, and the `fullText` of every `text_bearing` snapshot. Matching is normalised so composed and decomposed Unicode forms match each other ("composed search matches canonically equivalent decomposed public text").
- **Detail**: `/project-detail?id=<numeric id>`; a `localStorage` fallback carries the last selected id if the query is absent.
- **Return**: "← Return to Showcase" link on every detail page.
- **Not implemented**: URL-encoded filter state (R-4), result counts and reset control (R-5), pagination (the 120-record harness renders all cards in one page).

---

## 9. Evidence

### 9.1 Executable public-layer checks (this review, branch `docs/brief-design-analysis-20260912`)

`npm run test:public-layer` runs three scripts under `apps/public-layer/scripts/`:

| Script | What it proves | Result on this branch |
| :--- | :--- | :--- |
| `test-duda-feed-url-validator.js` | The feed URL validator accepts 2 well-formed `https` Supabase-shaped URLs and rejects 16 malformed / non-`https` / unexpected-host cases | passed ("2 accepted and 16 rejected cases passed") |
| `test-duda-current-feed-browser.js` | Headless Chromium scenarios over the three-record fixture and the contract cases at 1440×1000 and 390×844: listing, navigation, three presets, lightbox lifecycle, featured gallery, generic video, empty / malformed / parse-failed / failed feed, malformed snapshots, unsafe and escaped-text records, mixed-feed availability, and the `contract-*` cases. Each scenario proves its error-capture controls with positive tests before asserting zero unexpected console errors, window errors, and unhandled rejections. | passed ("40 Chrome scenarios passed") |
| `test-duda-annual-scale-browser.js` | Generates 120 synthetic records from the fixture shape; serves them locally with all hosts mapped to loopback; asserts 120 rendered cards with 120 unique detail targets, five representative searches plus no-match and clear, four single-facet cases plus two intersections, representative detail routes (first, middle, last), no horizontal overflow at 1440 and 390 px, and zero console / window / rejection errors, with no external contact and no Duda mutation. | passed (`DUDA_ANNUAL_SCALE_CLASSIFICATION = LOCAL_120_RECORD_RENDERING_VERIFIED`, `RECORDS = 120`, `CONSOLE_ERRORS = 0`, `WINDOW_ERRORS = 0`, `UNHANDLED_REJECTIONS = 0`, `EXTERNAL_CONTACT = NO`, `DUDA_SITE_MUTATION = NO`) |

These checks are **local**, **synthetic**, and **loopback-only**. They do not measure timing, payload size, memory, or Lighthouse metrics, and this document reports none. (The previous revision's figures — JavaScript and CSS byte counts, feed size, ingestion and search latencies, heap deltas, and memory-leak claims — were not produced by any retained executable evidence and have been removed rather than re-measured.)

### 9.2 Local synthetic / fixture browser observations (screenshots, 2026-09-12)

`LOCAL SYNTHETIC / FIXTURE BROWSER OBSERVATION`. Twenty PNG captures held outside Git at `D:\IT RMIT\Capstone.rollout\continuation-20260910\mg01-design-evidence-20260912\` (index: `scenario_summary.json`, all entries `CAPTURED`). They were taken against the repository public layer with the three-record synthetic fixture. Fixture media hosts were **not** served during capture, so poster and snapshot images appear as broken-image placeholders showing their alt text, and the hero region above the video player is blank in the full-page detail captures. Files re-inspected directly during this review are marked ✓; others are listed as captured.

| File | Viewport | What the capture shows |
| :--- | :--- | :--- |
| `01_main_listing_desktop.png` ✓ | 1440×1000 | Search input and four labelled selects in one row; "2026 Projects" and "2025 Projects" year headings; one card per year section (three-record fixture); "Learn more" button; poster image not served (alt text visible). |
| `01_main_listing_mobile.png` | 390×844 | Captured (listing, mobile). |
| `02_search_query_desktop.png` | 1440×1000 | Captured (search query applied). |
| `03_facet_year_2026.png`, `04_facet_program_cyber.png`, `05_facet_discipline_swe.png`, `06_facet_industry_health.png` | 1440×1000 | Captured (one facet applied each). |
| `07_no_result_state_desktop.png`, `07_no_result_state_mobile.png` | 1440 / 390 | Captured (empty state). |
| `08_detail_poster_desktop.png`, `08_detail_poster_mobile.png`, `08_detail_poster_fullpage_1440.png`, `08_detail_poster_fullpage_390.png` | 1440 / 390 | Captured (`poster_showcase`). |
| `09_detail_technical_desktop.png`, `09_detail_technical_fullpage_1440.png` | 1440 | Captured (`technical_detail`). |
| `10_detail_media_desktop.png`, `10_detail_media_fullpage_1440.png` | 1440 | Captured (`media_rich`). |
| `11_gallery_fulltext_disclosure.png`, `12_poster_fulltext_disclosure.png` ✓ | 1440 | `12_…` shows the top of the detail page: return link, "Capstone Exhibition" label, H1, metadata chips, abstract, red "Download Poster PDF" button, native video player, and the snapshot strip beneath. The disclosure itself is below the fold in this capture. |
| `11_12_disclosures_clicked_1440.png` ✓, `11_12_disclosures_opened_1440.png` ✓ | 1440 full page | Both show the "Read full text of image 1" and "Read full poster text" `<details>` summaries **collapsed** (closed marker), followed by Background, The Solution, The Team (group name and participant chips), Resources. **Neither capture shows the disclosure expanded.** The expanded state is proven by the executable check "poster full text can be visually expanded with native disclosure behavior", not by these screenshots. |
| `13_pdf_controls_technical.png`, `14_controlled_links_media.png` | 1440 | Captured (PDF action; external links). |
| `15_mobile_navigation_order.png` ✓ | 390 | Order: return link → label → H1 → metadata chips → abstract → "Download Poster PDF" → snapshot strip with "Read full text of image 1" → "Read full poster text" → Background. **Observation**: the H1 ("Dashboard"), the supervisor chip, and the abstract line appear cut at the right edge of the 390 px capture. The executable harness asserts `scrollWidth <= clientWidth + 1` at 390×844 for detail pages and passes, so this may be a capture-harness viewport difference rather than document overflow. It is recorded as an **open re-audit item**, not resolved. |
| `19_error_fallback_feed_failed.png`, `19_error_fallback_empty_feed.png` | 1440 | Captured (bounded error and empty states). |

A screenshot cannot establish native screen-reader behaviour, memory behaviour, user satisfaction, search-engine indexing, or live-host compatibility, and none of those are claimed from these captures.

### 9.3 Accessibility — what is and is not claimed

Claimed (from source and executable checks):

- Semantic, selectable HTML is rendered for all text, including image full text.
- `altText` and `fullText` contracts exist and are enforced at render time (`text_bearing` requires non-blank trimmed text of at most 5000 characters; `ordinary` requires `fullText: null`).
- Automated DOM/browser checks exist for dialog semantics, accessible names, focus containment, Escape, focus restoration, heading structure, and disclosure behaviour.
- Keyboard behaviour is locally browser-tested **only where a check exercises it** (lightbox Tab / Shift+Tab / Escape / arrows).

Not claimed:

- WCAG 2.1 (any level) conformance.
- Any certification.
- Screen-reader compatibility — **no native screen-reader UAT has occurred**.
- Contrast ratios — no contrast measurement is part of the retained executable checks.
- Overall conformance inferred from passing component checks.

Current-release human keyboard, zoom, and native assistive-technology UAT remains pending. `docs/accessibility-uat-evidence/` covers Admin/CMS routes and states explicitly that it is "neither WCAG certification nor public showcase/Duda acceptance".

---

## 10. Content ownership model (public text)

To prevent misreading of the "full text of image content" requirement:

1. The **project team / participant** authors the concise alt text and the full-text equivalent for each text-bearing image, and the poster full text, through the intake and correction workflows.
2. **OCR and AI-assisted validation** in the Admin/CMS (`apps/admin-cms/src/assistive-validation/`) produce **findings** for staff — for example, title consistency between text and images. They are assistive and **non-authoritative**; their output is never published as the transcript.
3. **Staff** (`reviewer` / `admin`) review findings and content and approve, request changes, or archive.
4. The **accepted source or correction package** remains the publication authority; the feed carries what was accepted.

---

## 11. Requirement traceability (MG-01 scope only)

| Brief element | Where this document addresses it | Related implemented capability (evidence, not a claim of completion by this document) |
| :--- | :--- | :--- |
| Review of current layout | §3.2 | — |
| Review of current navigation | §3.1 | R-1, R-2 |
| Review of current content hierarchy | §3.2, §7 | R-8, R-9, R-10 |
| Review of current usability | §3.3 | R-12 – R-14 |
| Recommendations: clarity | §6.2, §7 | R-8, R-9 |
| Recommendations: accessibility | §6.4, §9.3 | R-16 – R-18 (MG-05 accepted locally) |
| Recommendations: discoverability | §6.1, §8 | R-1, R-3 (MG-04 Admin four-facet filtering accepted locally; public facets in `bodyend.html`) |
| Recommendations: visual impact | §6.5 | R-22, R-23 |
| Working within third-party (Duda) constraints | §3.5, §5, §6.6 | R-26, R-27 |
| Full text versions of image content (referenced) | §6.4, §10 | R-16 (MG-05) |
| Search and filtering by discipline, industry, year, program (referenced) | §8 | R-1 (MG-04) |
| 100+ projects per year (referenced) | §9.1 | 120-record local harness |
| Multiple programs incl. future programs (referenced) | §4.2 | MG-03 named/future-program operability (accepted locally) |
| Voting | excluded | — |

---

## 12. Remaining work and human / institutional decisions

MG-01 is a design and reporting artifact. At `d6cd337` the repository already contains accepted local implementation for MG-02 (standardised form intake), MG-03 (named/future-program operability), MG-04 (Admin four-facet filtering), and MG-05 (gallery full-text equivalents). MG-06/07 exist on a separate, not-yet-integrated documentation branch. No further milestone roadmap is defined by this document.

Remaining items, by category:

- **Exact-head re-audit**: re-run the public-layer harnesses and screenshot captures at the integrated head, with fixture media served; resolve the 390 px clipping observation in §9.2.
- **Single identical 100+ integrated cohort proof**: one cohort of 100+ records passing intake → review → publication → public rendering on the same head.
- **GitHub / CI**: PR, external review, CI on the integrated branch.
- **Hosted staging**: inject the public layer into a staging Duda site; verify theme interaction (R-27), detail URL behaviour (R-2), and feed fetch from hosted Storage.
- **Real SMTP / participant UAT**: preview links and confirmation workflow with real mail delivery.
- **Accessibility UAT**: R-19 – R-21 (keyboard, zoom, native screen readers, formal assessment).
- **Institutional inputs**: brand tokens (R-7), facet vocabulary ratification, decisions on R-4/R-5 and R-28, designation of staff roles.
- **Authorized live Impact deployment**: only after the above, by the School's decision.

### 12.1 Non-claims

1. No live Duda deployment or publishing has occurred.
2. No participant / staff UAT has occurred for the public layer.
3. No taxonomy has been ratified by the School.
4. No accessibility conformance or certification is claimed.
5. No performance metrics are claimed.
6. Voting is excluded.

This document does not declare PP1 (or any programme-level phase) complete.
