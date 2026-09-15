# Duda TEST layout-recipe verification

This package is prepared for a separately authorised operator. It contains exact repository-owned
renderer bytes and does not itself access Duda, write a hosted feed, or publish anything.

## Hard target boundary

- Environment: **TEST only**
- Duda site ID: `c5bc8c6b`
- Site alias: `testwww-rmitvn-showcase-comsset`
- Listing page slug: `sst-school-projects`
- Reusable detail page slug: `project-detail`
- Live RMIT/Impact site: **forbidden**
- Duda **Publish/Republish: forbidden**. Editor Save on the verified TEST target is the maximum
  permitted action for this checklist.

Stop before making any change if the editor does not show all three exact TEST identifiers. Do not
infer the target from branding, a browser tab title, or a similar hostname.

## Before-state and checksum gate

1. Run `node verify-package.mjs` in the package directory. Require its single PASS result.
2. Compare the five renderer hashes with `SHA256SUMS.txt`; record them in the evidence note.
3. On the exact TEST site, copy the current body-end HTML, listing/detail HTML widgets, listing/detail
   CSS, and current `window.CAPSTONE_FEED_URL` configuration into an operator-owned rollback folder.
   Hash those before-state files and record the TEST site ID, alias, slugs, date, and operator.
4. Confirm the proposed feed URL separately. It must be the reviewed non-production public Supabase
   Storage URL, use HTTPS, contain no credentials/query/hash, and end in either
   `/storage/v1/object/public/feeds/capstones-latest.json` or
   `/storage/v1/object/public/public-feeds/capstones-latest.json`.
5. Confirm no production/live browser tab is open for editing.

## TEST-only installation

1. Put the reviewed feed URL assignment (based on `feed-url-config.example.html`) before the exact
   contents of `bodyend.html` in the TEST site's body-end injection point. Do not edit renderer bytes.
   Hash the complete installed body-end region and the extracted `bodyend.html` renderer block
   separately; the complete region is expected to differ because it includes the feed assignment.
2. On `/sst-school-projects`, find the existing HTML widget that owns
   `#capstone-showcase-root`/`#capstone-project-grid`. If its content already matches
   `listing-page.html`, retain it; do not create a duplicate widget or duplicate IDs.
3. On `/project-detail`, find the existing HTML widget that owns `#project-detail`. If its content
   already matches `detail-page.html`, retain it; do not create a duplicate widget or duplicate ID.
4. Treat an HTML widget's Content, its Duda-generated Design CSS, Developer Mode page CSS, and the
   site body-end injection point as four different surfaces. `listing-page.css` and
   `detail-page.css` belong in Developer Mode page CSS, not in the selected widget's Design panel.
5. Before changing either complete page CSS region, preserve and compare it with the captured
   before-state. Keep unrelated Duda/page rules unchanged. Replace only an identifiable prior PP1
   Capstone module block with one authoritative current candidate block, bounded by these comments:

   ```css
   /* PP1 CAPSTONE MODULE BEGIN — candidate <sha> */
   /* exact repository listing-page.css or detail-page.css bytes */
   /* PP1 CAPSTONE MODULE END */
   ```

   If the prior module boundary cannot be identified safely, stop and obtain review; never replace
   the complete page CSS region with the repository module CSS file.
6. Save only in the TEST editor. Do not choose Publish or Republish.
7. Re-copy the installed regions. Hash each complete page CSS region and its extracted candidate
   block separately. Compare only the extracted candidate blocks (and extracted body-end renderer)
   with `manifest.json`, after recording any CRLF/LF normalization. The complete page CSS and
   body-end regions are not expected to match module-file hashes.

## Behavioural checklist

Use synthetic/non-sensitive staging records only. Record the feed record ID/public ID used for each
case and capture sanitised evidence.

- Existing historical records and each stock template (`poster_showcase`, `technical_detail`,
  `media_rich`) retain their prior presentation.
- A named recipe copied into a new project renders its distinct section order on `/project-detail`;
  no recipe ID, version, name, or administration field appears in the feed/page.
- New recipes cannot hide the snapshots section. Safe hidden optional sections are absent, while
  team/context, poster full text, accessibility text, snapshot alternatives, and text-bearing image
  full text remain available as applicable.
- Featured video/snapshots/poster is elevated when present; a missing selected medium falls back
  without an empty frame or duplicate controls.
- Listing search, clear/no-match, Year/Program/Discipline/Industry filters and a filter intersection
  work; retained cards navigate to `/project-detail?id=<numeric-id>`.
- Unknown/missing IDs and malformed/unsafe optional media fail boundedly without exposing private
  URLs or breaking unrelated records.
- Poster/PDF actions, gallery open/close/reopen, video controls/links, full-text disclosures, back
  navigation, and external links have no duplicate buttons.
- At 1440 desktop, 768 tablet, and true 390/375/320 mobile viewport widths there is no horizontal
  document or component overflow.
- Keyboard-only traversal reaches search, filters, cards, disclosures, gallery/lightbox controls,
  links and return action in a sensible order; focus is visible and Escape restores lightbox focus.
- Browser zoom at 200% preserves readable content and operable controls. Record console errors,
  window errors, and unhandled rejections; all unexpected counts must be zero.

This is hosted TEST evidence, not live acceptance, WCAG certification, or a universal flawlessness
claim. If any item fails, stop and report the exact defect without publishing.

## Rollback

1. Restore the exact before-state body-end, page HTML/CSS, and feed configuration from the rollback
   folder to the same verified TEST site.
2. Save only in the TEST editor; do not Publish/Republish.
3. Re-copy and hash the restored regions. Require equality with the recorded before-state hashes.
4. Re-run listing load, one filter/search, one historical detail route, keyboard focus, and 320 px
   overflow smoke checks. Record whether rollback was required and its result.

The operator must attach the package manifest/hashes, before/after hashes, target identifiers,
sanitised screenshots, checklist outcomes, and rollback status to the integration handoff.
