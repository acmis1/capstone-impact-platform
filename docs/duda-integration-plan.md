# Duda Integration Plan: Stable Public Feed

## 1. Scope and capability states

The Admin/CMS is the source of truth. Duda is a presentation client that reads one approved-only JSON artifact; it never receives a Supabase secret and never queries private project tables.

| Capability | Target proof | Admin/CMS action | Duda effect |
| --- | --- | --- | --- |
| Disposable Local publication | Loopback Supabase URL | `POST /api/projects/[publicId]/local-publication` after a fresh plan and Local acknowledgement | Writes Local storage only; no Duda site can consume localhost. |
| PP1 staging/test-showcase publication | Exact staging runtime identity, exact configured Supabase host match, and `CAPSTONE_STAGING_PUBLICATION_ENABLED=true` | `POST /api/projects/[publicId]/staging-publication` after a fresh plan and explicit staging acknowledgement | Replaces the stable non-production feed that the separately configured Duda TEST showcase can fetch. |
| Live production publication | Unavailable | No route or UI control exists. | The live Impact site is not published or changed. |

The staging route reuses the same controlled publication coordinator as Local execution. Fresh readiness, permission checks, global exclusivity, artifact binding, deterministic media promotion, prior-feed restoration, uploaded-byte/contract verification, audit, snapshot, finalization, recovery, and compensation remain authoritative. There is no unrestricted execution mode.

## 2. Stable feed contract

- **Bucket**: server-derived `SUPABASE_PUBLIC_FEEDS_BUCKET` (default `public-feeds`).
- **Object**: server-derived `SUPABASE_PUBLIC_FEED_FILE` (default and canonical value `capstones-latest.json`).
- **URL shape**: `https://<staging-project>.supabase.co/storage/v1/object/public/public-feeds/capstones-latest.json` when the defaults are used.
- **Stable URL principle**: Duda configuration stays fixed. Publication overwrites the verified object bytes at the same path.
- **Caching**: `Prototype/duda/bodyend.html` appends a timestamp query parameter and requests the feed with `cache: "no-store"`.

A successful Admin/CMS response displays the project public ID, `COMPLETED` or `ALREADY_COMPLETED`, record count, SHA-256, publication snapshot ID, and the server-derived public feed URL. It never returns a service key, private/signed URL, or client-selected bucket/path.

## 3. Staging execution policy

All three trusted server conditions must hold:

1. `CAPSTONE_RUNTIME_ENV` is exactly `staging`;
2. the actual HTTPS, non-loopback Supabase target hostname exactly matches `CAPSTONE_EXPECTED_SUPABASE_HOST`; and
3. `CAPSTONE_STAGING_PUBLICATION_ENABLED` is exactly `true` (case-insensitive after trimming).

Missing, malformed, disabled, production/live, mismatched, arbitrary remote, HTTP, and loopback configurations fail closed. `NODE_ENV`, request JSON, query parameters, browser flags, and browser-supplied storage destinations are never publication authority. `CAPSTONE_STAGING_MUTATION_CONFIRMATION` remains the separate acknowledgement contract for staging CLI mutation commands; it does not unlock the web route.

## 4. Duda TEST compatibility

The existing TEST-site renderer remains `Prototype/duda/bodyend.html`, with the reusable listing/detail HTML and CSS beside it. It consumes one `window.CAPSTONE_FEED_URL`, renders listing/search/filter data, selects detail records by the existing numeric `id`, and supports the current poster, `posterPdf`, accessible poster text, snapshots, layout configuration, links, categories, program, discipline, industry, and year fields.

The Admin/CMS feed also includes `publicId` and the additive `snapshotMedia: [{ url, altText }]` contract. The current Duda script still renders the unchanged `snapshots: string[]` shape and does not yet consume `snapshotMedia` alt text. That is a non-blocking media/accessibility follow-up owned outside this integration slice; no Duda template or teammate media work is absorbed here.

Only `published` projects compile into the ordinary feed. An approved candidate appears in the candidate artifact only inside controlled publication, and becomes part of the ordinary feed only after atomic finalization changes it to `published`. Archived or removed records are excluded by the compiler; hosted public-removal execution remains a separate future capability.

## 5. Separately authorised staging demonstration

The implementation and CI must not execute these external-write steps. After review, an operator with separate authorisation for the specific hosted staging publication should:

1. Verify the deployed Admin/CMS revision and that hosted staging has the required publication schema/RPC/storage baseline.
2. Verify the web service has the exact staging runtime identity and expected Supabase hostname, then explicitly set `CAPSTONE_STAGING_PUBLICATION_ENABLED=true`. Keep all database administrative credentials server-only.
3. Confirm `SUPABASE_PUBLIC_FEEDS_BUCKET` and `SUPABASE_PUBLIC_FEED_FILE` resolve to the intended public staging feed and canonical `capstones-latest.json` object. Do not accept a destination from the browser.
4. Confirm the Duda TEST showcase—not the live site—already points `window.CAPSTONE_FEED_URL` at that exact stable public URL. Any Duda TEST configuration change requires its own authorisation.
5. Sign in as publication-authorised staff, open the approved project, confirm authoritative readiness is `READY`, and generate a fresh publication plan.
6. Review the plan evidence, acknowledge the non-production staging warning, and choose **Publish to staging showcase** once.
7. Record the returned public ID, result code, record count, SHA-256, snapshot ID, and stable feed URL.
8. Fetch the stable feed with cache busting, validate it against the public-feed contract, and confirm the intended `publicId` is present with only approved public fields.
9. Refresh the Duda TEST listing and reusable detail page and confirm the project appears/updates correctly. Do not publish or modify the live Duda site.
10. Disable `CAPSTONE_STAGING_PUBLICATION_ENABLED` after the demonstration if that is the agreed operational posture.

The legacy Prototype `/api/publish-cloud-feed` path and the standalone simplified staging feed publisher are not the Admin/CMS publication architecture and must not be invoked for this demonstration.
