# Duda annual-scale rendering evidence

Status: `LOCAL_120_RECORD_RENDERING_VERIFIED`.

This evidence is bounded to the repository Duda client running locally at
exact start SHA `c3698c690c62016a1508d69bdc03a1add357f492` on branch
`feat/duda-annual-rendering-evidence`. It does not access or mutate Duda,
Supabase, Render, GitHub, external media, analytics, or any production
service.

## Evidence gap

The current Duda browser harness already proves public rendering, search,
filters, reusable detail routing, accessibility behavior, URL safety, and
error capture for its three-record fixture. The 2026-09-08 TEST acceptance
also used one governed synthetic published record. Neither directly evidenced
the repository renderer consuming an annual-scale 100+ record feed.

## Test design

The active `apps/public-layer/scripts/test-duda-annual-scale-browser.js` derives exactly 120
synthetic records programmatically from the valid current three-record fixture
shape. It does not add a large duplicated JSON fixture. Generated records have
unique positive numeric IDs (`260001` through `260120`), unique public IDs and
titles, paired public-safe poster/PDF/snapshot/video URLs, exact governed
snapshot alternatives and positions, full poster text, concise accessibility
text, team data, and one of the three current layout presets.

The script computes the expected fixture counts before browser execution. The
local HTTP server replaces media hosts with `127.0.0.1`, intercepts the
Supabase-shaped feed request in-page, serves synthetic local media, and runs
Chrome/Edge headless with background networking disabled and all hostnames
mapped to loopback. The actual `bodyend.html`, listing/detail HTML, and both
listing/detail CSS files are loaded into every scenario.

The browser scenarios are:

- listing/search/facets at `1440x1000`;
- the same listing/search/facets at `390x844`;
- direct detail routes for the first (`260001`), middle (`260060`), and last
  (`260120`) records.

## Results

Historical evidence command:

```text
node Prototype/scripts/test-duda-annual-scale-browser.js
```

The active equivalent is:

```text
npm run test:public-layer-annual-scale-browser
```

Observed result:

```text
DUDA_ANNUAL_SCALE_CLASSIFICATION = LOCAL_120_RECORD_RENDERING_VERIFIED
RECORDS = 120
LISTING_CARDS = 120
DETAIL_TARGETS_VALID = 120/120
SEARCH_CASES = 7 (five representative searches, no-match, clear)
FACET_CASES = 6 (four facets, two intersections)
REPRESENTATIVE_DETAILS = 3/3
DESKTOP_OVERFLOW = NO
MOBILE_OVERFLOW = NO
CONSOLE_ERRORS = 0
WINDOW_ERRORS = 0
UNHANDLED_REJECTIONS = 0
EXTERNAL_CONTACT = NO
DUDA_SITE_MUTATION = NO
```

The five search cases cover title, case-insensitive title, public ID,
industry partner, and group name. Their independently computed expected
result counts are `1`, `1`, `1`, `32`, and `20`; deterministic no-match is
`0`, and clearing search restores `120`.

The four facet cases have independently computed expected counts: Year
`2026` = `20`, Program `Master of Cyber Security` = `30`, Discipline `User
Experience Design` = `30`, and Industry `Education` = `28`. Search plus Year
returns the intended single record. Program plus Industry returns `7`, and
clearing filters restores all `120` records.

Every listing card has two native detail actions. Both action sets contain the
same 120 unique numeric targets, every target belongs to exactly one generated
record, and each action has a project-specific accessible name. The first,
middle, and last detail routes each resolve the intended H1, program, partner,
team, poster text, accessibility text, governed snapshot alternatives, safe
links, and current detail layout. The exact public ID is verified in the
fixture route mapping; the current detail template does not separately print
the public ID as visible text.

The harness positively captures console errors, window errors, and unhandled
promise rejections before clearing those controls. It then requires zero
unexpected application errors. Rendered active URLs are checked for unsafe
schemes and private/signed markers, and external actions retain
`noopener noreferrer`.

## Verification boundary

The existing harness listing regression passed before implementation:

```text
PASS listing at 1440x1000: 40 browser checks
PASS listing at 390x844: 40 browser checks
Duda current-feed browser harness: 2 Chrome scenarios passed.
```

The full existing harness passed all `40` Chrome scenarios. The focused Admin
current-feed contract and fixture tests passed `2` test files and `125` tests.
This local annual evidence does not prove live Impact publication, Duda
production performance or capacity, production network/CDN latency,
simultaneous visitors, publication concurrency, stakeholder UAT,
native-screen-reader accessibility certification, or staff-effort reduction.

No actual renderer defect was reproduced at 120 records. The production
renderer files remain byte-identical; no renderer fix was made.
