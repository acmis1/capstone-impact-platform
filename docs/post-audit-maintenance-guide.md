# Post-audit maintenance guide

This guide describes the governed maintenance release (Migration 0062) and its operator controls. It is not a deployment receipt. Confirm that the deployed application, database and assistive worker match the intended release before using new controls. Historical release observations remain dated evidence, not current-state claims.

## Create and inspect a reusable layout

Open **Layout recipes**. Choose a maintained preset, name the recipe, and inspect the **Representative public preview** as you change section order, optional visibility and featured media. Switch the example between a rich package and poster-only content to see absent-content behavior. The example is synthetic and illustrative, not an actual project's final public page.

**Project background / motivation** and **Solution & impact** are optional package fields. Neither is the poster or the required short public summary. The title, summary, project information and poster regions remain fixed in the maintained templates. The composer labels those regions separately from reorderable body sections. A supplied gallery, team/group context and poster accessibility description cannot be hidden. Poster full text and image accessibility description are different fields.

Featuring video or a gallery moves it outside ordinary section order. Missing preferred media falls back to available video, then gallery, then poster; a poster-only project retains its poster. The live example reports the effective feature. A preset change that would discard edits asks for confirmation. Save creates an immutable recipe version; subsequent edits create another version. Retire confirms the exact recipe and removes it from future choices without changing existing projects or previews.

## Change an existing project's layout

An administrator can open **Projects → project → Project layout** for a private **Draft** or **Changes requested** project. Choose a stock configuration or an active saved recipe, inspect the representative preview and exact change summary, then choose **Save layout configuration** and **Confirm layout change**. Cancel preserves the draft. Saving the same value creates no new change.

This copies the selected configuration by value. A later edit to the reusable recipe does not change this project. The change audit records before/after configuration and, when selected, the recipe identity/version. Existing intake-only copies without provenance are not retroactively labelled as coming from a particular recipe.

Layout changes never edit participant-owned text or physical assets and never publish. Any active participant preview is revoked; historical snapshots and responses remain retained. Follow the ordinary review, fresh preview/confirmation and publishing-readiness workflow afterward. In-review or approved projects first use **Request changes**; a currently published project must first complete canonical archive/removal, restore to its supported private state, then request changes. Do not use deletion/recovery as a shortcut around review. Unfinished publication/removal/recovery anywhere in the canonical feed blocks conflicting maintenance.

## Inspect and recover a soft-deleted project

Administrators can use **Deleted projects** from Projects or its Deleted status filter. Search the paginated retained records and open a tombstone to inspect deletion, media and historical evidence. A normal active-project search still excludes deleted rows.

When the server proves exact deletion provenance and required public-removal evidence, **Recover to private Draft → Confirm recovery** restores the lifecycle to Draft. This is different from **Restore project** for archived projects. Recovery preserves physical files, prior participant evidence and all publication/removal/audit history; it does not reinstate approval or old participant confirmation. Ambiguous legacy deletion records remain read-only and cannot be recovered automatically.

## Manage project categories without losing history

**Project categories** provides active/retired filters, search and bounded pages. Retirement stops new assignments while existing associations and historical names remain readable. Reactivate makes a retained value available again. Rename is accepted only when the database proves zero canonical or legacy project references, including deleted records. For a referenced typo, create the corrected value and retire the old one instead. Case-equivalent duplicates are refused. An in-progress project write may return a busy result; reload before trying again.

The displayed use count deduplicates each project across its canonical and legacy references. No category is physically deleted. Layout recipes and taxonomy management intentionally remain administrator capabilities; a separate delegable designer role is not introduced by this release.

## Preserve unfinished intake work

The import screen protects unsaved work when switching intake methods, following links, using browser history or leaving/reloading the page. Cancel keeps the draft; explicitly discarding leaves once rather than replaying the navigation. The browser's own unload warning may still be used when leaving the entire site.

Use the offered progress export/restore controls before a long interruption. The versioned file contains project information and selection metadata, not source-file bytes, executable state, credentials or participant capability links. Store it appropriately. Restore never grants a saved validation result: reselect source files, repeat required School-reference inspection and obtain a fresh server preview before committing. A pre-save progress file is not a backup of already-committed metadata/media or a substitute for import history.

## Browse and check results

Import history supports bounded navigation and search instead of hiding batches older than the first 50. Publishing history supports project/activity/date filtering; history links lead to the relevant project. Staff directories support filtering and pagination. Project facts use staff-friendly labels and UTC timestamps; exact technical identifiers remain available in a disclosure.

Public showcase cards show real visible titles. Search and year/category filters can be shared through the URL and retained when opening a detail page and returning. The listing reports the result count and offers a reset. A feed failure displays a visitor-oriented retry action, not a raw backend error. Synthetic 120- and 1,000-record browser scenarios are evidence for those tested data sets, not a production latency guarantee.

## Participant and assistive evidence

The participant page explicitly identifies itself as a content-confirmation preview; public visual styling may differ. It includes the required summary, expiry and a review acknowledgement before confirmation. Confirmation never publishes. Expired/revoked links require a fresh authorized preview; staff must not reuse old confirmation after a changed layout or recovered lifecycle.

The title-candidate correction uses document evidence, not the submitted title, to choose likely headings. Its durable pipeline version changes to v4 so v3 results cannot masquerade as newly checked evidence. Historical valid v3 findings remain readable and are marked stale against the current pipeline. The app and worker must agree on exact deployment/pipeline identity. Findings remain assistive only and do not grant approval or publication authority.

## Unknown outcomes and demonstration readiness

A network failure can occur after a write committed. When any maintenance panel says the outcome is unknown, stop and use its reload action to inspect authoritative state before a deliberate new attempt. Unknown does not mean failed or unchanged. Do not change database rows, public feed contents or stored media to force a green result.

A free hosted service may sleep and show its provider's loading page before the application wakes. Open the application ahead of a demonstration and verify readiness and the processing worker. Keep the authorized worker host running. Use the clean synthetic demo package and its backup, not confusing previously archived/deleted fixtures. No live Duda Publish/Republish is needed for the TEST integration.

Staff UAT was unavailable; developer/assistant self-verification must be labelled accordingly. Managed backup/PITR and agreed recovery targets, provider email qualification, destination-aware worker egress hardening, institutional ownership and real efficiency measurements remain separately tracked. This guide does not assert those external acceptance outcomes.
