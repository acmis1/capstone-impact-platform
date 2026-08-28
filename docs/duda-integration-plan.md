# Duda Integration Plan: Stable Public Feed

## 1. Scope and capability states

The Admin/CMS project lifecycle is the editorial/business source of truth. The public deployment ledger and its explicit head are the intended public deployment truth, and the stable Storage object is the externally served exact copy of that head. Duda is a presentation client that reads that public-only JSON artifact; it never receives a Supabase secret and never queries private project tables.

| Capability | Target proof | Admin/CMS action | Duda effect |
| --- | --- | --- | --- |
| Disposable Local publication | Loopback Supabase URL | `POST /api/projects/[publicId]/local-publication` after a fresh plan and Local acknowledgement | Writes Local storage only; no Duda site can consume localhost. |
| Disposable Local rollback | Loopback Supabase URL, `CAPSTONE_RUNTIME_ENV=local`, explicit rollback enablement, and a rollback-capable activated head | Prepare and execute from `/admin/public-feed` with the exact acknowledgement | Restores an exact historical Local artifact as a new ledger version; it cannot affect Duda. |
| PP1 staging/test-showcase publication | Exact staging runtime identity, exact configured Supabase host match, and `CAPSTONE_STAGING_PUBLICATION_ENABLED=true` | `POST /api/projects/[publicId]/staging-publication` after a fresh plan and explicit staging acknowledgement | Replaces the stable non-production feed that the separately configured Duda TEST showcase can fetch. |
| Live production publication | Unavailable | No route or UI control exists. | The live Impact site is not published or changed. |

The staging route reuses the same controlled publication coordinator as Local execution. Fresh readiness, permission checks, global exclusivity, exact artifact binding, deterministic media promotion, uploaded-byte/head verification, audit, snapshot, finalization, fencing, and forward recovery remain authoritative. After `WRITE_STARTED`, the coordinator never restores the old baseline; it converges on the one durably bound candidate. There is no unrestricted execution mode, and rollback remains unavailable outside disposable Local.

## 2. Stable feed contract

- **Bucket**: server-derived `SUPABASE_PUBLIC_FEEDS_BUCKET` (default `public-feeds`).
- **Object**: server-derived `SUPABASE_PUBLIC_FEED_FILE` (default and canonical value `capstones-latest.json`).
- **URL shape**: `https://<staging-project>.supabase.co/storage/v1/object/public/public-feeds/capstones-latest.json` when the defaults are used.
- **Stable URL principle**: Duda configuration stays fixed. Publication overwrites the verified object bytes at the same path.
- **Head agreement**: A completed operation requires the Storage bytes, SHA-256, and record count to match the immutable version selected by `public_feed_head`.
- **Caching**: `Prototype/duda/bodyend.html` appends a timestamp query parameter and requests the feed with `cache: "no-store"`.

A successful Admin/CMS response displays the project public ID, `COMPLETED` or `ALREADY_COMPLETED`, record count, SHA-256, publication snapshot ID, and the server-derived public feed URL. It never returns a service key, private/signed URL, or client-selected bucket/path.

## 3. Staging execution policy

All three trusted server conditions must hold:

1. `CAPSTONE_RUNTIME_ENV` is exactly `staging`;
2. the actual HTTPS, non-loopback Supabase target hostname exactly matches `CAPSTONE_EXPECTED_SUPABASE_HOST`; and
3. `CAPSTONE_STAGING_PUBLICATION_ENABLED` is exactly `true` (case-insensitive after trimming).

Missing, malformed, disabled, production/live, mismatched, arbitrary remote, HTTP, and loopback configurations fail closed. `NODE_ENV`, request JSON, query parameters, browser flags, and browser-supplied storage destinations are never publication authority. `CAPSTONE_STAGING_MUTATION_CONFIRMATION` remains the separate acknowledgement contract for staging CLI mutation commands; it does not unlock the web route.

## 4. Duda TEST compatibility

The existing TEST-site renderer remains `Prototype/duda/bodyend.html`, with the reusable listing/detail HTML and CSS beside it. It consumes one `window.CAPSTONE_FEED_URL`, renders listing/search/filter data, selects detail records by the existing numeric `id`, and supports the current poster, `posterPdf`, accessible poster text, snapshots, layout configuration, links, categories, program, discipline, industry, and year fields. Its feed URL validator intentionally accepts exactly the legacy Prototype `feeds/capstones-latest.json` path and the Admin/CMS staging `public-feeds/capstones-latest.json` path.

The staging demonstration must configure the latter Admin/CMS staging path; legacy Prototype material legitimately continues to use the former path.

The Admin/CMS feed also includes `publicId` and the additive `snapshotMedia: [{ url, altText, galleryPosition }]` contract. The Duda renderer retains `snapshots: string[]` as the display-order and lightbox compatibility projection, but resolves every rendered snapshot's authoritative `altText` by exact URL match. Unpaired, duplicate, blank, private-draft, signed, authenticated, or malformed snapshot entries are omitted rather than rendered with an invented or incorrectly paired alternative. A bad pair does not remove its project or any unrelated project.

`Prototype/duda/current-feed-contract-cases.json` holds the paired server/client cases. `apps/admin-cms/src/feed/dudaCurrentFeedContract.test.ts` runs each case through the authoritative `validatePublicFeed` and through the Duda record policy extracted verbatim from `bodyend.html`. The compatibility assertion considers every representative server-valid record directly; the fixture has no client-rejection flag that can hide a disagreement. Unsafe active URLs fail the authoritative server boundary, while Duda independently removes only the unsafe optional field/link or snapshot pair and keeps the record renderable.

`Prototype/scripts/test-duda-current-feed-browser.js` provides the repository-only integration proof. It serves the representative current-contract fixture locally and exercises the listing, filters, reusable detail routing, media/link behavior, all layout presets, bounded failure states, exact snapshot alternatives, and representative mobile/desktop overflow checks in an installed headless Chrome or Edge browser. It also exercises the paired contract cases in the real browser: optional presentation defaults, automatic featured-media selection, non-contiguous gallery positions, external URLs with query strings, repeated lightbox open/close/reopen with explicit transition counting, and field-local removal of signed, authenticated, token-bearing and percent-encoded private Storage assets. Its mixed-feed scenario proves that valid A and D remain visible/navigable, B remains visible with an unsafe optional URL removed, and only structurally unusable C is omitted through listing filters and all retained detail routes. Each run first proves its own error capture with bounded positive controls for `console.error`, window errors and unhandled rejections, then clears them so every scenario still requires zero unexpected errors. The static-quality matrix runs the complete harness once on Linux, where the GitHub runner supplies Chrome; Windows and macOS do not duplicate it. The harness does not publish a feed or contact Duda, Supabase, Render, or `/api/publish-cloud-feed`.

Only lifecycle-`published` projects compile into the ordinary lifecycle projection. Once deployment history is active, controlled publication composes the exact current deployment head plus one approved target, and removal removes only the requested member from that head. This prevents a prior rollback from being silently undone by recompiling every lifecycle-`published` row. Atomic finalization changes a normal publication target to `published`; deployment reconciliation may add an already-`published` but undeployed project without replaying its lifecycle transition. Hosted public-removal and rollback execution remain separately unavailable.

## 5. Separately authorised staging demonstration

The implementation and CI must not execute these external-write steps. After review, an operator with separate authorisation for the specific hosted staging publication should:

1. Verify the deployed Admin/CMS revision and that hosted staging has the required publication-ledger schema/RPC/storage baseline. Governed baseline activation must have established exact Storage/head agreement before publication.
2. Verify the web service has the exact staging runtime identity and expected Supabase hostname, then explicitly set `CAPSTONE_STAGING_PUBLICATION_ENABLED=true`. Keep all database administrative credentials server-only.
3. Confirm `SUPABASE_PUBLIC_FEEDS_BUCKET` and `SUPABASE_PUBLIC_FEED_FILE` resolve to the intended public staging feed and canonical `capstones-latest.json` object. Do not accept a destination from the browser.
4. Confirm the Duda TEST showcase—not the live site—already points `window.CAPSTONE_FEED_URL` at that exact stable public URL. Any Duda TEST configuration change requires its own authorisation.
5. Sign in as publication-authorised staff, open the approved project, confirm authoritative readiness is `READY`, and generate a fresh publication plan.
6. Review the plan evidence, acknowledge the non-production staging warning, and choose **Publish to staging showcase** once.
7. Record the returned public ID, result code, record count, SHA-256, snapshot ID, and stable feed URL.
8. Fetch the stable feed with cache busting, validate it against the public-feed contract, and confirm the intended `publicId` is present with only approved public fields.
9. Refresh the Duda TEST listing and reusable detail page and confirm the project appears/updates correctly. Do not publish or modify the live Duda site.
10. Disable `CAPSTONE_STAGING_PUBLICATION_ENABLED` after the demonstration if that is the agreed operational posture.

The legacy Prototype `/api/publish-cloud-feed` path is not the Admin/CMS publication architecture and must not be invoked for this demonstration. The former standalone staging feed publisher fails closed; all canonical writes must pass through the unified ledger writer.
