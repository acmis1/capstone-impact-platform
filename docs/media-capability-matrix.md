# Media Capability Matrix and Controlled-Link Audit

This document records the current implemented media capability boundary for the Capstone Impact Platform.

Executable code, database migrations, and automated tests remain the higher-precedence source of truth. This matrix summarizes those behaviors and must be updated when the implementation changes.

## Audit Classification

The audit labels in this section are intentionally distinct from the capability-matrix status labels below.

| Capability / surface | Current behavior | Audit classification |
| :--- | :--- | :--- |
| Poster PDF end-to-end | `poster.pdf` is a required project-package role, validated separately from the poster image, bounded to 20 MB, checked by real file signature during server staging, privately staged, available to Admin through public or short-lived signed preview URLs, participant-previewed as a document link, and promoted only through the controlled publication-media path. | `implemented+tested` |
| Project video URL | `project-details.xlsx` accepts the optional `videoUrl` field through the centralized alias contract. The value is validated, server-reparsed, persisted to `projects.video_url`, rendered as a normal safe Admin link, and conditionally preserved by the public-feed compiler. It is not rendered as a dedicated participant-preview field. | `implemented but incomplete` |
| Live demo / prototype URL | `project-details.xlsx` accepts the optional `demoUrl` field, with the same controlled validation, server-authoritative staging, database persistence, Admin safe-link rendering, and public-feed preservation. It is not rendered as a dedicated participant-preview field. | `implemented but incomplete` |
| Source repository URL | `project-details.xlsx` accepts the optional `repositoryUrl` field, with the same controlled validation, server-authoritative staging, database persistence, Admin safe-link rendering, and public-feed preservation. It is not rendered as a dedicated participant-preview field. | `implemented but incomplete` |
| Legacy `project.json` controlled-link intake | `project.json` remains a legacy developer/testing compatibility path. It does not provide the new dedicated video/demo/repository URL intake contract and is not expanded by this work. | `legacy/compatibility` |
| `media_assets.asset_type = video_link` | The domain type remains recognizable for compatibility/future modelling, but controlled publication artifacts support only `poster_image`, `poster_pdf`, and `snapshot_image`. `video_link` is rejected as publication media and is not a binary upload role. | `future-only` |

## Source and Architecture Boundary

`project-details.xlsx` is the standard package metadata source for the three controlled external links.

The browser preview is advisory only. Server staging reparses the selected package and persists URL values from the authoritative server manifest. The browser does not supply an independent field that can replace those destinations.

The existing database columns `video_url`, `demo_url`, and `repository_url` are used; no parallel media subsystem or new binary-video storage model is introduced.

External project links remain ordinary safe web links. This work does not introduce binary video upload, transcoding, audio, arbitrary embeds, arbitrary HTML, autoplay, 3D media, AI-generated captions/transcripts, or Duda-side changes.

## Authoritative Media Capability Matrix

The exact status vocabulary for this matrix is:

- `Implemented and tested`
- `Implemented but limited`
- `Unsupported`
- `Future`

| Capability | Package source | Validation | Private / Admin preview | Participant preview | Public feed / publication | Accessibility | Limitations | Overall status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Poster image | Required `poster.png` package role | `Implemented and tested` — required-role, MIME, size, filename and actual-byte validation are enforced through the import/staging path. | `Implemented and tested` — private staged media uses controlled signed preview; approved media uses its authoritative public URL. | `Implemented and tested` — private preview uses a short-lived signed media URL. | `Implemented and tested` — publication requires the poster image and promotes it through the controlled public-media path. | `Implemented and tested` — authoritative poster description comes from `accessibilityText`; no filename-derived fallback is used. | No OCR/AI-derived accessibility text. | `Implemented and tested` |
| Poster PDF | Required `poster.pdf` package role | `Implemented and tested` — distinct required role, PDF MIME handling, 20 MB maximum, size checks and `%PDF-` actual-byte signature verification are enforced. | `Implemented and tested` — Admin provides filename/type/size information, inline PDF preview where supported, safe open-in-new-tab action, bounded unavailable state and small-screen fallback. Private signing failure does not expose provider errors, bucket names or storage paths. | `Implemented and tested` — participant preview treats the PDF as a document link backed by a short-lived signed URL. | `Implemented and tested` — poster PDF is required publication media and remains distinct from the poster image. | `Implemented and tested` — poster full text is provided separately by the authoritative `posterText` value; the PDF does not receive an invented media-level alt value. | Browser PDF iframe support varies, so a normal document link remains the reliable fallback. | `Implemented and tested` |
| Gallery image | Optional numbered snapshot image roles, positions 1–10 | `Implemented and tested` — supported image validation, bounded gallery position and authoritative per-image alt-text binding are enforced. | `Implemented and tested` — ordered Admin previews and per-media accessibility review/editing preserve media identity. | `Implemented and tested` — exact snapshotted gallery media and alt text are rendered in numeric position order. | `Implemented and tested` — controlled publication preserves ordered snapshot media and structured gallery data while retaining the compatibility snapshot projection. | `Implemented and tested` — each included gallery image requires authoritative staff-authored alt text. | Duda-side consumption of the structured gallery remains outside this work. | `Implemented and tested` |
| Video URL | Optional `Project video URL` workbook field | `Implemented and tested` — centralized aliases, 2,048-character bound, URL parsing, HTTP(S)-only policy, credential/unsafe-scheme/unsafe-character rejection and authoritative server reparse. | `Implemented and tested` — rendered as a normal safe external Admin link labelled `Video`; no arbitrary embed or autoplay is introduced. | `Unsupported` — the dedicated `videoUrl` field is not part of the participant-preview snapshot or dedicated participant renderer. | `Implemented and tested` — safe values are conditionally preserved by the public-feed compiler; unsafe/private values fail feed validation. It is not publication binary media. | `Implemented but limited` — the Admin link has an accessible action label, but video captions/transcripts and embedded-player accessibility are outside this URL-only capability. | URL only. No binary video upload, transcoding, arbitrary iframe/embed, autoplay, caption generation, or `video_link` media promotion. | `Implemented but limited` |
| Demo URL | Optional `Live demo URL` workbook field | `Implemented and tested` — same controlled URL contract and authoritative server reparse as the video URL. | `Implemented and tested` — rendered as a normal safe external Admin link labelled `Live demo / prototype`. | `Unsupported` — the dedicated `demoUrl` field is not part of the participant-preview snapshot or dedicated participant renderer. | `Implemented and tested` — safe values are conditionally preserved by the public-feed compiler and unsafe/private values fail validation. | `Implemented but limited` — accessible normal-link semantics are provided; accessibility of the external prototype itself is outside platform control. | No arbitrary HTML, iframe or embedded prototype execution inside Admin/CMS. | `Implemented but limited` |
| Repository URL | Optional `Source repository URL` workbook field | `Implemented and tested` — same controlled URL contract and authoritative server reparse as the other controlled links. | `Implemented and tested` — rendered as a normal safe external Admin link labelled `Repository`. | `Unsupported` — the dedicated `repositoryUrl` field is not part of the participant-preview snapshot or dedicated participant renderer. | `Implemented and tested` — safe values are conditionally preserved by the public-feed compiler and unsafe/private values fail validation. | `Implemented but limited` — normal accessible link semantics are provided; accessibility and availability of the external repository are outside platform control. | External repository only; no code ingestion, execution, mirroring or embedded repository UI. | `Implemented but limited` |

## Participant Snapshot and Staleness Boundary

The current participant-preview snapshot contains its existing `externalLinks` collection, but it does not contain dedicated `videoUrl`, `demoUrl`, or `repositoryUrl` fields.

Therefore this work does not add those three project fields to participant snapshot hashing or staleness evaluation merely because they exist in the Project domain or public feed.

If a future participant-facing design renders these dedicated fields, their exact values must first become part of the immutable participant snapshot and the applicable stale-confirmation calculation before that display can be considered authoritative.

Existing participant correction, reissue, expiry and stale-preview behavior remains unchanged.

## Publication Boundary

Controlled external URLs are metadata fields, not publication media objects.

Publication-media promotion remains restricted to:

- `poster_image`
- `poster_pdf`
- `snapshot_image`

A `video_link` media row is not promoted, copied, or treated as binary/public media.

Safe controlled URL values may appear in the public feed through their dedicated `videoUrl`, `demoUrl`, and `repositoryUrl` fields only after public-feed validation. Draft/private storage URLs, signed private URLs, unsafe schemes, credentials and other prohibited URL material fail closed.

## Known Limitations and Future Work

Dedicated video/demo/repository links are not currently included in participant preview.

There is no binary video upload, transcoding, hosted streaming media, audio pipeline, arbitrary iframe/embed system, autoplay behavior, AI-generated caption/transcript feature, 3D media pipeline, or new Duda integration in this capability.

The existing `video_link` media type should not be interpreted as implemented publication support. Any future activation requires a separate architecture, security, accessibility and publication review.