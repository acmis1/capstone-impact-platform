# Media Capability Matrix and Controlled-Link Audit

This document records the current implemented media capability boundary for the Capstone Impact Platform.

Executable code, database migrations, and automated tests remain the higher-precedence source of truth. This matrix summarizes those behaviors and must be updated when the implementation changes.

## Audit Classification

The audit labels in this section are intentionally distinct from the capability-matrix status labels below.

| Capability / surface | Current behavior | Audit classification |
| :--- | :--- | :--- |
| Poster PDF end-to-end | `poster.pdf` is a required project-package role, validated separately from the poster image, bounded to 20 MB, checked by real file signature during server staging, privately staged, available to Admin through public or short-lived signed preview URLs, participant-previewed as a document link, and promoted only through the controlled publication-media path. | `implemented+tested` |
| Project video URL | `project-details.xlsx` accepts the optional `videoUrl` field through the centralized alias contract. The value is validated, canonicalized, server-reparsed, persisted to `projects.video_url`, rendered as a normal safe Admin link, captured in the immutable participant snapshot, rendered to the participant as an ordinary external link, covered by confirmation/staleness detection, and conditionally emitted by the public-feed compiler. | `implemented+tested` |
| Live demo / prototype URL | `project-details.xlsx` accepts the optional `demoUrl` field, with the same controlled validation, canonicalization, server-authoritative staging, database persistence, Admin safe-link rendering, participant-snapshot capture, participant rendering, staleness coverage, and public-feed emission. | `implemented+tested` |
| Source repository URL | `project-details.xlsx` accepts the optional `repositoryUrl` field, with the same controlled validation, canonicalization, server-authoritative staging, database persistence, Admin safe-link rendering, participant-snapshot capture, participant rendering, staleness coverage, and public-feed emission. | `implemented+tested` |
| Legacy `project.json` controlled-link intake | `project.json` remains a legacy developer/testing compatibility path. It does not provide the new dedicated video/demo/repository URL intake contract and is not expanded by this work. | `legacy/compatibility` |
| `media_assets.asset_type = video_link` | The domain type remains recognizable for compatibility/future modelling, but controlled publication artifacts support only `poster_image`, `poster_pdf`, and `snapshot_image`. `video_link` is rejected as publication media and is not a binary upload role. | `future-only` |

## Source and Architecture Boundary

`project-details.xlsx` is the standard package metadata source for the three controlled external links.

The browser preview is advisory only. Server staging reparses the selected package and persists URL values from the authoritative server manifest. The browser does not supply an independent field that can replace those destinations.

A populated controlled URL is **canonicalized once**, at validation, and the canonical form is what is persisted, snapshotted, rendered and compared. The raw workbook cell text is never persisted. The TypeScript validator deliberately refuses to rely on WHATWG URL repair: an input such as `https:///path` or `https:\evil.example.com/x` is rejected outright rather than silently rewritten into a different origin. The validator additionally re-asserts the database's own defence-in-depth predicate against the canonical value, so a URL that passes staff-facing validation cannot then be rejected opaquely at the RPC boundary. The migration's SQL predicate remains the final authority and is not weakened. Staff-facing validation errors never echo the offending raw value.

The existing database columns `video_url`, `demo_url`, and `repository_url` are used; no parallel media subsystem or new binary-video storage model is introduced.

External project links remain ordinary safe web links. This work does not introduce binary video upload, transcoding, audio, arbitrary embeds, arbitrary HTML, autoplay, 3D media, AI-generated captions/transcripts, or Duda-side changes.

### Reachability is not validated

Loopback, private-network and intranet HTTP(S) hosts (`http://localhost:3000/demo`, `https://10.0.0.5/demo`, `https://intranet.internal/demo`) are accepted by every layer, exactly as they were before this work.

**Public-feed validation does not prove global public routability.** What it actually rejects is private *storage* material — signed private object URLs, and private-access credentials carried in a query string or fragment — which is a different property from network reachability. Whether the showcase should publish an unroutable link is a separate, bounded policy decision that has not been made, and is deliberately not made here.

## Authoritative Media Capability Matrix

The exact status vocabulary for this matrix is:

- `Implemented and tested`
- `Implemented but limited`
- `Unsupported`
- `Future`

| Capability | Package source | Validation | Private / Admin preview | Participant preview | Public feed / publication | Accessibility | Limitations | Overall status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Poster image | Required `poster.png` package role | `Implemented and tested` — required-role, MIME, size, filename and actual-byte validation are enforced through the import/staging path. | `Implemented and tested` — private staged media uses controlled signed preview; approved media uses its authoritative public URL. | `Implemented and tested` — private preview uses a short-lived signed media URL. | `Implemented and tested` — publication requires the poster image and promotes it through the controlled public-media path. | `Implemented and tested` — authoritative poster description comes from `accessibilityText`; no filename-derived fallback is used. | No OCR/AI-derived accessibility text. | `Implemented and tested` |
| Poster PDF | Required `poster.pdf` package role | `Implemented and tested` — distinct required role, PDF MIME handling, 20 MB maximum, size checks and `%PDF-` actual-byte signature verification are enforced. | `Implemented and tested` — Admin provides filename/type/size information, a file-specific keyboard-operable open-in-new-tab action, and an inline desktop preview kept out of sequential keyboard focus. The inline frame is hidden below the `sm` breakpoint, where the new-tab action is the whole interaction. Private signing failure does not expose provider errors, bucket names or storage paths. | `Implemented and tested` — participant preview treats the PDF as a document link backed by a short-lived signed URL. | `Implemented and tested` — poster PDF is required publication media and remains distinct from the poster image. | `Implemented and tested` — poster full text is provided separately by the authoritative `posterText` value; the PDF does not receive an invented media-level alt value. Native PDF viewers can trap keyboard focus and do not reliably report load or error events, so the inline frame carries `tabIndex={-1}` and the page never asserts a load result it cannot observe, nor holds a permanent loading status. | Browser PDF iframe support varies, so a normal document link remains the reliable fallback. | `Implemented and tested` |
| Gallery image | Optional numbered snapshot image roles, positions 1–10 | `Implemented and tested` — supported image validation, bounded gallery position and authoritative per-image alt-text binding are enforced. | `Implemented and tested` — ordered Admin previews and read-only per-media accessibility review preserve media identity. | `Implemented and tested` — exact snapshotted gallery media and alt text are rendered in numeric position order. | `Implemented and tested` — controlled publication preserves ordered snapshot media and structured gallery data while retaining the compatibility snapshot projection. | `Implemented and tested` — each included gallery image requires authoritative project-team-authored alt text. | Duda-side consumption of the structured gallery remains outside this work. | `Implemented and tested` |
| Video URL | Optional `Project video URL` workbook field | `Implemented and tested` — centralized aliases, a 2,048-character bound applied to both the raw and the canonical value, a literal absolute-HTTP(S) form required before parsing, canonicalization, credential/unsafe-scheme/unsafe-character rejection, authoritative server reparse, and a database predicate the TypeScript validator provably agrees with. | `Implemented and tested` — rendered as a normal safe external Admin link labelled `Video`; no arbitrary embed or autoplay is introduced. | `Implemented and tested` — the exact canonical `videoUrl` is captured in the immutable participant snapshot and rendered to the participant as an ordinary external link, before the response controls. No embed, no iframe, no autoplay. | `Implemented and tested` — safe values are conditionally emitted by the public-feed compiler; private storage URLs and private-access credentials fail feed validation. It is not publication binary media. | `Implemented but limited` — the Admin and participant links carry distinct accessible action labels, but video captions/transcripts and embedded-player accessibility are outside this URL-only capability. | URL only. No binary video upload, transcoding, arbitrary iframe/embed, autoplay, caption generation, or `video_link` media promotion. Reachability is not validated. | `Implemented but limited` |
| Demo URL | Optional `Live demo URL` workbook field | `Implemented and tested` — same controlled URL contract, canonicalization and authoritative server reparse as the video URL. | `Implemented and tested` — rendered as a normal safe external Admin link labelled `Live demo / prototype`. | `Implemented and tested` — the exact canonical `demoUrl` is captured in the immutable participant snapshot and rendered as an ordinary external link before the response controls. | `Implemented and tested` — safe values are conditionally emitted by the public-feed compiler; private storage URLs and private-access credentials fail validation. | `Implemented but limited` — accessible normal-link semantics are provided; accessibility of the external prototype itself is outside platform control. | No arbitrary HTML, iframe or embedded prototype execution inside Admin/CMS. Reachability is not validated. | `Implemented but limited` |
| Repository URL | Optional `Source repository URL` workbook field | `Implemented and tested` — same controlled URL contract, canonicalization and authoritative server reparse as the other controlled links. | `Implemented and tested` — rendered as a normal safe external Admin link labelled `Repository`. | `Implemented and tested` — the exact canonical `repositoryUrl` is captured in the immutable participant snapshot and rendered as an ordinary external link before the response controls. | `Implemented and tested` — safe values are conditionally emitted by the public-feed compiler; private storage URLs and private-access credentials fail validation. | `Implemented but limited` — normal accessible link semantics are provided; accessibility and availability of the external repository are outside platform control. | External repository only; no code ingestion, execution, mirroring or embedded repository UI. Reachability is not validated. | `Implemented but limited` |

## Participant Snapshot and Staleness Boundary

The three controlled project links are part of the immutable participant-confirmed evidence.

Because a controlled link can appear on the public project page, the participant must be shown the exact destination before confirming. Migration 0050 therefore projects `videoUrl`, `demoUrl` and `repositoryUrl` into the single canonical participant-facing project snapshot at all three authorities that build it:

1. `public.generate_participant_preview` — issuance, which captures the immutable snapshot;
2. `public.get_project_publication_readiness` — the normal publication staleness gate;
3. `public.get_project_reconciliation_readiness` — the deployment reconciliation staleness gate.

A snapshot issued from migration 0050 onward always carries all three keys. An absent link is captured as JSON `null`, so the snapshot shape does not vary with which links a project happens to have.

Populated values are re-validated when the participant page is rendered, rather than trusted from storage. Immutable evidence containing an unusable controlled URL fails closed through the existing bounded preview-unavailable behavior. The offending field is never silently dropped while still letting the participant confirm incomplete evidence, and an unsafe `href` is never produced. The unrelated generic `externalLinks` collection keeps its existing degrade-to-text handling and is not changed by this work.

### Historical snapshot compatibility

Stored participant-preview snapshots are never rewritten, and old confirmation JSON is never backfilled in place. Previews issued before migration 0050 carry none of the three keys, and comparison semantics account for that explicitly:

| Stored snapshot | Current project values | Result |
| :--- | :--- | :--- |
| Missing the three keys | All three `NULL` | Equivalent for these fields |
| Missing the three keys | Any controlled URL populated | `PROJECT_SNAPSHOT_STALE` |
| Contains the three keys | Unchanged | Equivalent |
| Contains the three keys | Any of the three changed | `PROJECT_SNAPSHOT_STALE` |

Pre-contract previews are therefore not grandfathered once controlled-link content exists: the participant would be confirming evidence that does not mention a link the public page would carry. Returning a value to its exact snapshotted destination can restore equality, provided every other readiness gate also passes.

Corrected content requires a new exact participant preview and confirmation. Expiry and snapshot-staleness rules remain authoritative.

### Participant-owned correction packages

The project team owns submitted public content, controlled links, media, poster text and image descriptions. Staff check completeness and technical quality, request corrections, accept an exact participant revision, and retain approval and publication authority. Staff metadata editors, gallery description editors and assistive apply controls are read-only; legacy server actions reject direct content writes.

Before the first participant preview, staff can upload a complete project-team-supplied replacement for a completed import in draft, submitted, in-review or changes-requested state. The same parser, immutable candidates, exact comparison and recovery transaction apply. Staff freeze and accept the package without changing its content or automatically approving the project. Provenance records staff transport separately from project-team authorship.

After requesting a correction through an active preview, the project team uploads a complete replacement `project-details.xlsx`, poster image, poster PDF and optional numbered supporting images. The server validates the source bytes and stages an immutable candidate in private Storage. Submission leaves authoritative project content unchanged. Staff compare current and proposed fields, file hashes, descriptions and omissions. Beginning review freezes the selected candidate, revokes the old preview and moves the project to changes requested.

Acceptance applies only that frozen package. Metadata, media rows, project taxonomy mappings, complete recovery records and obsolete-row retirement commit in one database transaction. Every old Storage object remains intact; shared taxonomy catalogues are never retired. Prepared new objects remain bounded and retryable if Storage or database completion fails. Acceptance neither approves nor publishes. Normal technical review, staff reapproval, a corrected preview and fresh participant confirmation follow before publication readiness.

Migration 0051 implements these workflows with authenticated staff transport before preview and the existing participant preview capability afterward; participants need no account or CMS access. This implements the advisor's expressed concern and still requires final UAT and stakeholder sign-off. See [participant correction handoff](participant-owned-corrections-handoff.md) for limits, ownership and verification evidence.

## Publication Boundary

Controlled external URLs are metadata fields, not publication media objects.

Publication-media promotion remains restricted to:

- `poster_image`
- `poster_pdf`
- `snapshot_image`

A `video_link` media row is not promoted, copied, or treated as binary/public media.

Safe controlled URL values may appear in the public feed through their dedicated `videoUrl`, `demoUrl`, and `repositoryUrl` fields only after public-feed validation. Draft/private storage URLs, signed private URLs, unsafe schemes, credentials and other prohibited URL material fail closed.

The public showcase renders a controlled link safely. A video URL is embedded only when it matches the showcase's strict allowlist, which reconstructs a canonical YouTube or Vimeo embed URL from an extracted identifier; any other value falls through to a plain link, so an arbitrary submitted URL can never become an iframe source. Demo and repository URLs are rendered only as ordinary links. No Duda-side change is made by this work.

**Staff retain publication authority.** Participant confirmation means only "the participant confirmed this exact immutable project evidence". It does not publish anything, and it does not by itself move a project through the workflow. The order is unchanged:

```text
project submission
→ deterministic/staff checks
→ staff approval
→ participant preview
→ participant confirmation or correction request
→ publication readiness
→ publication
```

## Known Limitations and Future Work

There is no binary video upload, transcoding, hosted streaming media, audio pipeline, arbitrary iframe/embed system, autoplay behavior, AI-generated caption/transcript feature, 3D media pipeline, or new Duda integration in this capability.

Controlled-link reachability (loopback, private-network and intranet hosts) is accepted and unvalidated; a routability policy is a separate bounded decision.

The existing `video_link` media type should not be interpreted as implemented publication support. Any future activation requires a separate architecture, security, accessibility and publication review.

**No stakeholder or UAT acceptance is claimed for this capability.** The statuses above record what the implementation and its automated tests do — not that the behavior has been demonstrated to, or accepted by, the advisor, the school, or any participant.
