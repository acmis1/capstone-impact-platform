# Tran Thien Tan — poster PDF and controlled-project-link integration record

**STATUS:** Current — teammate contribution/provenance record  
**LAST VERIFIED:** 2026-09-04  
**FINAL SOURCE OF TRUTH:** `main` after merge commit `744a3b7d0ccf0777846e20401f9fb400e424d9a1` (PR #262)

## Purpose

This document records what happened to **Tran Thien Tan's** poster-PDF and controlled-project-link work during final PP1 integration so his contribution remains traceable after the original draft PR was superseded.

It is intentionally teammate-facing rather than a replacement for the system handover documents. For the resulting platform contract, also read:

- [`docs/participant-owned-corrections-handoff.md`](../participant-owned-corrections-handoff.md)
- [`docs/media-capability-matrix.md`](../media-capability-matrix.md)
- [`docs/project-details-workbook-contract.md`](../project-details-workbook-contract.md)

## 1. Provenance and final disposition

Tan's source contribution was:

- **PR #255** — `feat(admin-cms): support poster PDFs and controlled project links`
- Branch: `Tan/poster-pdf-controlled-links`
- Final PR head: `7b1def49cc46825bc8c3e00090f9e793d6cd1a91`
- Original feature work: controlled Video / Live demo / Repository URLs, workbook/import persistence, safe rendering, poster-PDF preview/fallback, public-feed preservation, and supporting tests/docs.

During that branch's lifetime, **PR #257** (`fix(a11y): prevent PDF preview keyboard trap`) landed on `main`. Tan then synced `main` into his branch, so the final #255 head already contained that accessibility correction.

The controlled-link/PDF work was then integrated and further hardened inside:

- **PR #262** — `feat(participant): integrate owned correction workflow`
- Final PR head: `60667ae01a047a3ce3f0d13632aed1ada776ec53`
- Merged to `main` as: `744a3b7d0ccf0777846e20401f9fb400e424d9a1`

PR #255 was therefore **closed as superseded and was not merged separately**. Its functionality is present in final `main` through PR #262.

## 2. What Tan originally implemented and what happened to it

| Tan's original area | Final integration disposition |
| --- | --- |
| Optional project Video URL | **Retained** and made participant-confirmed evidence before publication. |
| Optional Live demo / prototype URL | **Retained** and made participant-confirmed evidence before publication. |
| Optional Repository URL | **Retained** and made participant-confirmed evidence before publication. |
| Workbook column definitions and aliases for the three URLs | **Retained**. Ownership wording was corrected from staff-authored to project-team-authored where applicable. |
| Workbook parser support | **Retained and hardened** through stronger controlled-URL canonicalization/parity checks. |
| Browser import metadata staging | **Retained**. The database migration that stages the three links remains the authoritative initial-import path. |
| Central controlled-URL validator | **Retained and substantially hardened**; see Section 4. |
| Admin/CMS controlled-link display | **Retained** with safe canonical URLs and clearer labels. |
| Poster PDF support | **Retained**. |
| Poster PDF inline preview | **Retained but accessibility/responsiveness hardened**; see Section 3. |
| Public-feed preservation of supported controlled links | **Retained**. |
| Controlled-link migration | **Retained exactly** as Migration 0049. |
| Migration/runtime/readiness/recovery tests needed for the new migration | **Retained and then advanced to the final 51-migration repository state**. |
| Capability/workbook documentation | **Retained and extended** to explain participant-owned corrections and immutable preview evidence. |

## 3. Poster PDF changes made after/during Tan's work

### 3.1 Accessibility reconciliation from PR #257

The original PDF preview behavior was reconciled with the accessibility fix before final integration.

Changes made:

- Removed stateful `iframe` loading/error UI that relied on native PDF viewer `load`/`error` signals, because those signals do not reliably describe whether the embedded PDF viewer is usable.
- Removed the persistent `Loading PDF preview...` state.
- Kept the native inline PDF viewer available for pointer/touch users.
- Added `tabIndex={-1}` to the PDF `iframe` so the browser-native PDF viewer is **not in sequential keyboard focus** and cannot trap keyboard traversal.
- Kept the titled `iframe`; it is not hidden from accessibility APIs.
- Kept an explicit keyboard-operable **open-in-new-tab** link as the supported keyboard route.
- Added truthful static fallback guidance instead of pretending the page can reliably detect native viewer load/failure.
- Replaced the malformed local synthetic Medical Drone PDF fixture with a deterministic valid one-page PDF.
- Reconciled its local `media_assets.file_size_bytes` metadata so existing synthetic local stacks do not keep stale size evidence.
- Added regression tests for focus behavior, deterministic PDF structure, metadata reconciliation/idempotency, and fail-closed fixture identity drift.

### 3.2 Final PR #262 PDF integration changes

PR #262 then made two additional user-facing refinements without undoing the PR #257 safety contract:

- The explicit link now includes the filename in its accessible/visible action text, for example `Open project.pdf in a new tab`.
- The embedded native viewer is hidden below the `sm` breakpoint because it is not usable in the narrow project-detail column; small screens keep the static guidance and new-tab action instead.

The final rule is therefore:

> Desktop/tablet may use the inline viewer, but it is skipped by sequential keyboard focus. Small screens and keyboard users always have the explicit new-tab route.

## 4. Controlled URL hardening added during integration

Tan introduced `validateProjectControlledUrl(...)` as the central validator. The final integration kept that API but hardened the contract substantially.

### 4.1 Literal URL form is checked before WHATWG parsing

The final validator now checks that the original input is literally an absolute `http://` or `https://` URL with an authority before calling `new URL()`.

This prevents WHATWG URL repair from silently accepting/reinterpreting malformed input such as extra slashes or backslash forms that the database would reject.

### 4.2 TypeScript and SQL validation are kept in parity

A separate `projectControlledUrlSatisfiesDatabaseContract(...)` helper now mirrors Migration 0049's SQL predicate. A dedicated parity test protects the browser/server validator from drifting away from the database contract.

This closes the failure mode where the TypeScript layer accepted a URL that later failed opaquely at `stage_browser_import_metadata`.

### 4.3 Canonicalization became authoritative

Valid input is parsed and stored/rendered/compared using the canonical `URL.href`, rather than returning the trimmed raw text.

The validator re-checks the **canonical** value against the 2048-character limit and database contract because canonicalization can percent-encode and lengthen an input.

### 4.4 Character and credential protections were strengthened

The final validator rejects:

- ASCII control characters and DEL;
- Unicode whitespace;
- Unicode format/control characters such as zero-width and BiDi-format characters;
- embedded URL credentials / `@` in the authority;
- non-HTTP(S) schemes;
- relative and scheme-relative forms;
- malformed literal authority forms.

### 4.5 What was deliberately *not* added

The validator still does **not** claim URL reachability or perform network fetches. Loopback/private/intranet HTTP(S) hosts remain a separate publication-policy question; the intake validator is structural and safety-focused, not a link crawler.

## 5. Workbook/import changes made during integration

Tan's three optional workbook fields and aliases remain the contract:

- `Project video URL` → `videoUrl`
- `Live demo URL` → `demoUrl`
- `Source repository URL` → `repositoryUrl`

The integration changed the surrounding ownership model:

- Workbook content is now explicitly described as **project-team-authored**, not staff-authored.
- Controlled URLs continue to be reparsed from `project-details.xlsx`; staff do not type/override participant-owned content through an ordinary Admin metadata editor.
- The normal initial browser-import path still persists the canonical values through `stage_browser_import_metadata`.
- The same workbook contract is reused when validating complete participant-authored correction packages and pre-preview replacement packages.
- Formula cells without usable cached results continue to fail closed.
- Invalid controlled URLs remain validation errors rather than being silently dropped or repaired into a different meaning.

## 6. Admin/CMS rendering changes

Tan's Admin media summary treatment was retained:

- `Video`
- `Live demo / prototype`
- `Repository`

The links are rendered only after passing `validateProjectControlledUrl(...)`, use the canonical validated URL, open in a new tab, and use `noopener noreferrer`.

The final labels remain action-oriented:

- `Open video`
- `Open live demo / prototype`
- `Open repository`

No arbitrary embed, binary video-upload role, or staff-authored link editor was added.

## 7. Migration lineage

### Migration 0049 — Tan's controlled-link import migration

File:

`infra/supabase/migrations/20260902010606_controlled_project_links_import.sql`

This migration was preserved **byte-for-byte** from Tan's final PR #255 head into merged `main`.

Blob SHA at PR #255 head and final merged `main`:

`04ead52bdcb971038f794640cb3266e026860bac`

It remains the authoritative initial-import persistence layer for optional `video_url`, `demo_url`, and `repository_url` values.

### Migration 0050 — participant-preview controlled-link evidence

Added during integration:

`infra/supabase/migrations/20260903120000_participant_preview_controlled_links.sql`

Reason: after Migration 0049, the three links could appear in the public feed but were not yet part of the immutable participant-confirmed snapshot. That created a possible evidence gap: participants could confirm snapshot A while publication later carried additional controlled-link content B.

Migration 0050 closes that gap by adding the three controlled links to the canonical participant snapshot used by:

1. participant preview issuance;
2. normal publication-readiness staleness checks;
3. deployment-reconciliation staleness checks.

Important boundary: old snapshots are **not backfilled or rewritten**.

### Migration 0051 — participant-owned corrections

Added during integration:

`infra/supabase/migrations/20260903130000_participant_owned_corrections.sql`

The controlled-link/PDF capability became part of the exact participant-owned correction package and evidence workflow rather than a separate staff editing path.

The complete correction package can carry:

- project-details XLSX;
- poster image;
- poster PDF;
- up to ten supporting snapshot images;
- the controlled Video / Live demo / Repository values in the workbook;
- project-team-authored accessibility descriptions and other project metadata.

The package is reparsed and validated server-side, privately staged, frozen as an exact candidate when staff begin review, then **Accepted** or **Returned**. Neither participant submission nor acceptance automatically approves or publishes the project.

The repository therefore moved from Tan's Migration 0049 contribution to a final **51-migration** repository state.

**Hosted boundary:** repository Migrations 49–51 are merged, but this document does not claim they have been deployed to hosted Supabase.

## 8. Participant preview and public-output changes

After Tan's import/public-feed work, integration extended the behavior so controlled links participate in the same evidence lifecycle as the rest of project content.

Final behavior:

- New participant previews capture Video / Live demo / Repository URLs as immutable snapshot fields.
- Participant-preview rendering exposes those links using the controlled URL safety contract.
- Confirmation applies to the exact snapshot including those links.
- Changing a controlled link after confirmation makes the project snapshot stale and blocks readiness until the workflow is reconciled.
- Publication/reconciliation readiness compares the controlled links as part of the participant-confirmed evidence.
- The public feed can continue to emit the supported controlled links after the normal readiness/publication gates are satisfied.

## 9. Participant-content ownership changes that affect Tan's feature

The final integration introduced a stronger ownership rule across the Admin/CMS:

> Project teams author public project content; staff review, request corrections, accept exact revisions, approve, publish, remove, and administer governance/reference data.

For Tan's controlled-link/PDF functionality this means:

- Video / Live demo / Repository values remain project-team content.
- Poster/PDF/media descriptions remain project-team content.
- Ordinary Admin/Editor direct project-metadata writes are blocked with `PARTICIPANT_CONTENT_OWNED`.
- Ordinary staff snapshot-alt editing controls were removed/blocked.
- Assistive OCR/language suggestions may be reviewed/copied, but cannot directly apply participant-owned content.
- Initial import remains a transport/intake path for the project-team package.
- Corrections use a complete project-team-authored package, not a staff override form.
- Staff still retain review, approval, publication/removal, audit, technical-validation and governance authority.

This is an integration boundary change, not removal of Tan's controlled-link feature.

## 10. Pre-preview package replacement added around the same workbook/media contract

PR #262 also added a staff transport workflow for a corrected **complete project-team package before the first participant preview**.

Staff with the required combined authority can select an existing eligible project and transport a replacement package supplied by the project team. The server reparses and validates the same package contract; staff cannot change the project's identity via the workbook or author arbitrary content overrides.

The selected candidate is compared, frozen, accepted or returned using the same immutable package/recovery machinery. This allows Tan's workbook-controlled links and poster PDF to participate in a safe complete-package replacement instead of becoming isolated special cases.

## 11. Verification and CI changes made to integrate the feature safely

These changes were made because Tan's work became part of a larger 51-migration participant-owned workflow. They are **integration/verification changes**, not a reassignment of Tan's original feature ownership.

### Release-evaluation harness

Binh's release-evaluation harness was preserved and adapted so its participant-correction cohort represents:

- approved project;
- active participant preview;
- open correction request;
- **no correction package submitted yet**;
- readiness = `CORRECTION_UNRESOLVED`;
- excluded from publication.

The full immutable package lifecycle is tested by the dedicated participant-owned-corrections runtime instead of being fabricated inside the release evaluator.

### Legacy verifier alignment

After Migration 0051 retired the old staff shortcut `start_participant_preview_correction_resolution`, several existing runtime verifiers still expected that shortcut to succeed. They were updated to the new fail-closed/package-based contract, including:

- participant preview runtime;
- participant preview notification runtime;
- approval edit-gate runtime;
- publication readiness runtime;
- publication preparation runtime.

The verifiers now distinguish ordinary app-layer participant-content ownership from trusted service-role/database capabilities and do not manufacture immutable correction evidence merely for shared cleanup-based runtime tests.

### Contributor rehearsal timeout

The contributor workflow's nested clean `npm ci` repeatedly exceeded a hard-coded 180-second internal deadline on GitHub-hosted runners. The finite guard was raised:

- old: `180_000` ms;
- final: `480_000` ms.

No package/dependency behavior changed.

### Integration follow-up commits on PR #262

The final PR branch included these compatibility/CI follow-ups after the primary participant-owned integration merge:

| Commit | Purpose |
| --- | --- |
| `5b0521146296f5d126d420eaecd35851c963cfa2` | Align staff-governance verifier with the correction route. |
| `5fb8c54ee5e8d08bf65d110fa0482224552d6535` | Keep governance verifier compatible with the project target. |
| `544ccdd9b84037ff1e478945edf418f1f9832dbc` | Align participant-preview/notification/approval runtime assumptions with the retired shortcut. |
| `bcb4016ea1a9b06721e10ed2d1673e926055d32b` | Align publication readiness/preparation verifiers with participant-owned corrections. |
| `c2f86a56732ce7805bda466064ca40ab69da6951` | Align approval/edit-gate verification with participant content ownership. |
| `60667ae01a047a3ce3f0d13632aed1ada776ec53` | Raise the contributor-rehearsal nested install guard to a realistic finite duration. |

## 12. Final verification status

Final PR-head CI for `60667ae01a047a3ce3f0d13632aed1ada776ec53` completed successfully before merge.

Post-merge `main` CI then ran again on:

`744a3b7d0ccf0777846e20401f9fb400e424d9a1`

and completed successfully, including:

- Static Quality & Build Gates — Ubuntu;
- Static Quality & Build Gates — Windows;
- Static Quality & Build Gates — macOS;
- Disposable Local Supabase Integration with 51 migrations;
- Disposable Participant-Owned Corrections Runtime;
- Disposable Contributor Workflow Rehearsal;
- Disposable Zero-Cost Recovery Rehearsal;
- Disposable PostgreSQL 17 Privilege Alignment;
- Disposable Public Deployment Ledger Runtime.

No hosted Supabase migration, hosted Auth/Storage mutation, Vercel/Render/Azure deployment, Duda publication, real email, or `/api/publish-cloud-feed` operation was performed as part of this integration.

## 13. All paths originally changed by PR #255

PR #255 changed **45 paths**. All of these paths were represented in the final integration work; semantic changes made after Tan's original implementation are described above.

### CI/readiness/recovery/migration-count integration

- `.github/workflows/ci.yml`
- `apps/admin-cms/src/app/api/readiness/route.test.ts`
- `apps/admin-cms/src/deployment/hostedDeploymentReadiness.test.ts`
- `apps/admin-cms/src/deployment/hostedDeploymentReadiness.ts`
- `apps/admin-cms/src/recovery/zeroCostRecovery.test.ts`
- `apps/admin-cms/src/scripts/onboardingCheck.ts`
- `apps/admin-cms/src/scripts/runDisposableLedgerRuntime.ts`
- `apps/admin-cms/src/scripts/verifyAssistiveDuplicateShortlistRuntime.ts`
- `apps/admin-cms/src/scripts/verifyAssistiveExecutionControlRuntime.ts`
- `apps/admin-cms/src/scripts/verifyAssistiveValidationJobRuntime.ts`
- `apps/admin-cms/src/scripts/verifyAssistiveValidationPersistenceRuntime.ts`
- `apps/admin-cms/src/scripts/verifyAssistiveValidationStaffInspectionRuntime.ts`
- `apps/admin-cms/src/scripts/verifyAssistiveValidationUpgradeRuntime.ts`
- `apps/admin-cms/src/scripts/verifyAssistiveWorkerHeartbeatRuntime.ts`
- `apps/admin-cms/src/scripts/verifyPasswordRecoveryRuntime.ts`
- `apps/admin-cms/src/scripts/verifyPublicFeedLedgerRuntime.ts`
- `apps/admin-cms/src/security/assistiveLanguageMigration.test.ts`
- `apps/admin-cms/src/security/assistiveWorkerHeartbeatMigration.test.ts`
- `apps/admin-cms/src/security/bulkProjectReviewMigration.test.ts`
- `apps/admin-cms/src/security/multiImageGalleryIntegrationMigration.test.ts`
- `apps/admin-cms/src/security/postgres17MaintainPrivilegeAlignmentMigration.test.ts`
- `apps/admin-cms/src/security/publicFeedActivationAuthorityMigration.test.ts`
- `apps/admin-cms/src/security/publicFeedTaxonomyOperationGuardMigration.test.ts`

### Poster PDF / controlled-link application code and tests

- `apps/admin-cms/src/components/admin-media/PdfMediaPreview.test.tsx`
- `apps/admin-cms/src/components/admin-media/PdfMediaPreview.tsx`
- `apps/admin-cms/src/components/admin/ProjectMediaSummary.test.tsx`
- `apps/admin-cms/src/components/admin/ProjectMediaSummary.tsx`
- `apps/admin-cms/src/components/admin/ProjectReviewCore.test.tsx`
- `apps/admin-cms/src/domain/projectControlledUrl.test.ts`
- `apps/admin-cms/src/domain/projectControlledUrl.ts`
- `apps/admin-cms/src/projects/projectMediaPreview.test.ts`

### Workbook/import contract and tests

- `apps/admin-cms/src/import/__tests__/browserImportMediaStageRoute.test.ts`
- `apps/admin-cms/src/import/__tests__/browserImportMetadataStage.test.ts`
- `apps/admin-cms/src/import/__tests__/browserImportPreview.test.ts`
- `apps/admin-cms/src/import/__tests__/parseProjectDetailsWorkbook.test.ts`
- `apps/admin-cms/src/import/importTypes.ts`
- `apps/admin-cms/src/import/parseProjectDetailsWorkbook.ts`
- `apps/admin-cms/src/import/projectDetailsWorkbookContract.ts`
- `apps/admin-cms/src/import/stageBrowserImportMetadata.ts`
- `apps/admin-cms/src/import/validateImportPackage.test.ts`
- `apps/admin-cms/src/import/workbookManifestAdapter.ts`

### Documentation and migration

- `docs/README.md`
- `docs/media-capability-matrix.md`
- `docs/project-details-workbook-contract.md`
- `infra/supabase/migrations/20260902010606_controlled_project_links_import.sql`

## 14. Credit and continuation guidance

### Contribution credit

**Original poster-PDF and controlled-project-link implementation:** Tran Thien Tan — PR #255.  
**PDF accessibility reconciliation:** PR #257.  
**Participant-preview evidence, ownership/correction integration and final reconciliation:** PR #262.  
**Final repository source of truth:** `main` after `744a3b7d0ccf0777846e20401f9fb400e424d9a1`.

### If Tan continues work

Do **not** continue from the old `Tan/poster-pdf-controlled-links` branch and do not try to merge PR #255 again.

Start from current `main`. The feature is no longer an isolated controlled-link/PDF branch: it now participates in participant-confirmed snapshots, participant-owned correction packages, readiness/staleness rules, recovery evidence, and the 51-migration contract documented above.
