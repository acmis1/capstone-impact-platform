# Admin/CMS Operator Guide

This guide is for school staff performing routine Admin/CMS work. It describes the current controlled workflow without database access, terminal commands, or bypasses. Environment-specific publishing, staff provisioning, recovery, and cloud administration require the authority named in the handover matrix.

For existing-project layouts, deleted-project recovery, category retirement and protected intake drafts, see the [Post-audit maintenance guide](post-audit-maintenance-guide.md).

## Before starting

- Use the institution-provided Admin/CMS address and staff account. Do not use the historical `Prototype/` application.
- Confirm the page identifies the intended test/staging environment before making a controlled change.
- Use only approved synthetic data in staging. Follow institutional privacy policy in any later production environment.
- If the service displays a permission, configuration, readiness, recovery, or identity error, stop and use the escalation table below.
- This guide describes the candidate's operator controls, not a deployment receipt. Each control requires the matching deployed release, environment, and capabilities. M60/M61 were self-verified in the dated 18 September 2026 staging release `79fe1b333d16fafe9aa15e5572e230d74640f365`; the M62 maintenance release was applied to staging later the same day, and the [release and closure status record](handover/release-closure-status.md) holds that receipt and the currently observed release identity. Do not infer hosted verification, staff UAT, provider qualification or institutional approval merely from this guide.
- Do not edit database rows, Storage objects, browser storage, feed JSON, or provider settings to “repair” a workflow.

## Sign in and navigate

1. Open `/login` and sign in with the institution-managed account.
2. After sign-in, use the primary navigation:
   - **Projects** for search, filters, project details, metadata, review, preview, publication preparation, and archive actions;
   - **Imports** for new batches, import history, validation, and submit-for-review;
   - **Publishing** for bounded deployment history, head/membership evidence, drift, and controlled recovery state;
   - **Staff access** only when the account has staff-management authority.
3. If a route is absent or reports access required, do not try another account or direct API route. Ask the administrator to confirm the assigned role.

## Import a project batch

1. Open **Imports → Import projects**.
2. Select one project folder or one batch parent folder using the approved package structure.
3. If required for the cohort, inspect and map the Admin Reference workbook before comparison.
4. Request the preview. No project is saved during this first preview step.
5. Review the batch summary and every package:
   - **Valid** packages may be selected.
   - **Warning** packages require explicit review and acknowledgement before selection.
   - **Invalid** packages remain blocked and cannot be selected.
6. Prepare the selected import. Re-select the folder if the browser reports that source files changed.
7. Choose **Import selected project details**. This creates/stages draft metadata in the test environment; it does not publish.
8. Choose **Import media and finish**. Wait for the completed result and do not close or repeat the action while it is running.
9. Open the resulting import batch and review the imported-project and media summaries.

If metadata staging succeeds but media staging fails, keep the recorded batch/project reference and escalate. Do not start a second import to hide the partial result.

## Understand blocking validation

The application deliberately blocks progression when authoritative evidence is incomplete or inconsistent. Common blockers include required metadata, invalid identifiers or workbook structure, private poster/media requirements, required reviewed text/alternatives, unresolved participant corrections, stale preview evidence, or permission/state mismatches.

- Ask the project team to correct its source files and supply a complete replacement package. Upload, compare, and explicitly accept the exact package through the supported correction workflow, then rerun the normal readiness action. Staff must not silently rewrite participant-owned public content.
- Treat warnings as review decisions, not errors to ignore. Record why an acknowledged warning is acceptable.
- Treat a stale/version-changed result as a request to refresh and reassess, not a reason to retry with an old page.
- Do not ask a developer to disable a gate or manually update status fields.

## Submit and review projects

### Submit for review

1. Open **Imports**, select the completed batch, and open its detail page.
2. Review each project’s readiness and staged-media summary.
3. Select only projects shown as ready.
4. Choose **Submit selected for review** and record the successful, already-submitted, blocked, or failed counts.
5. Open any blocked project and resolve the displayed cause through supported controls.

### Reviewer actions

1. Open the project from **Projects** and inspect current metadata, media, validation, history, and participant state.
2. Use only an action available for the current status and assigned role:
   - **Approve** when all evidence is acceptable;
   - **Request changes** with a clear review comment when correction is required;
   - **Archive** only when the project should leave the active workflow.
3. Refresh after any stale/concurrent result and reassess the current version.
4. Confirm the history/audit area records the action. Do not repeat a completed action to create a preferred message.

### Batch actions from Projects

Selections are current-page only. Use **Select current page** or row checkboxes, confirm the displayed count, and repeat separately after changing page, filters, or search. Panels are shown/enabled from server-derived roles and capabilities. A missing, disabled, or unavailable control is a stop/escalation condition, not permission to bypass it.

#### Batch review decisions

With selected rows, **Review selected projects** offers **Submit for review**, **Approve**, and **Request changes** when allowed. Choose one, read the authoritative check, and inspect each row. The result distinguishes ready, blocked, already complete, and needs refresh/cannot continue; mixed eligibility is expected. **Request changes** requires one shared comment (up to 4,000 characters), applied only to successful requests. Confirm using the displayed **Confirm and ...** action and record per-row outcomes. Refresh stale rows and inspect current state before any intentional retry.

#### Batch assistive checks

For **Assistive checks for selected projects**, choose **Check eligibility**, review ready/already active or current/blocked/invalid or stale rows, then **Confirm and enqueue ready projects**. The action is limited to 50 projects; clear selection and continue in another page/chunk for a larger cohort. It queues suggestions only and changes no metadata, findings, review, publication, or archive state. Read outcomes as enqueued, already active/current, blocked, invalid/stale, or failed—not completed; no completion time is promised. Assistive findings do not authorize approval or publication. Working assistive checks remain part of platform acceptance. Continue deterministic validation and review if the worker, limit, or role makes it unavailable, and escalate persistent unavailability.

## Participant preview lifecycle

1. A project must be approved before a participant preview can be generated.
2. Review the exact preview content before generating or sending a link.
3. Choose the supported preview action. Email delivery, if available, is separately configured and may be disabled.
4. The participant either confirms that exact preview or submits a correction request; these outcomes are mutually exclusive.
5. If a correction is requested, an authorized staff member starts controlled resolution, asks the project team/participant for a complete corrected package, compares and accepts the exact revision, obtains reapproval, and issues a new preview. Do not rewrite the participant-owned content or reuse/reconstruct an old preview link.
6. Confirmation becomes stale when authoritative participant-facing content changes. Generate a fresh preview through the normal lifecycle.
7. Schedule/cancel reminders only when the feature is enabled and the exact preview remains eligible.

Never copy preview tokens into tickets, training evidence, chat, logs, or screenshots.

## Prepare and execute publication

Publication preparation and publication execution are different actions.

1. On an approved, participant-confirmed project, review the publication-readiness result.
2. Choose the no-write preparation action and inspect the project, confirmation, count, and hash summary.
3. Preparation does not publish anything.
4. Execute publication only if the interface explicitly identifies the approved disposable-Local or staging/test-showcase environment, the operator has publication authority, the feature is enabled, and the exact acknowledgement is shown.
5. Live production publication is not established by this guide. Do not attempt to reach Duda or a live feed through another route.
6. After an authorized test publication, confirm the bounded completion result and inspect **Publishing** history/head evidence.

If the candidate changes after preparation, discard the stale plan and prepare again.

#### Batch publication

For **Publish selected approved projects**, verify the displayed target: **Local test-showcase feed**, **Staging test-showcase feed**, or **Production live feed**. The panel allows up to 50; choose **Review publication batch**, inspect the server preflight and exact list, acknowledge that exact target/list, then choose the displayed **Confirm and publish** action. Eligible rows run sequentially through canonical feed writers; there are no automatic retries and no Duda Publish/Republish call. Published/currently public projects require canonical archive/removal first; a former-published project is eligible again only after verified removal. Production requires separate enablement and verified target identity. On **Unknown**, stop; later rows are **Not attempted**. Refresh and inspect project/feed state before an intentional retry; the batch never resumes automatically.

## Archive or unpublish

Archiving changes the project lifecycle. Removing a project from the deployed feed is a controlled writer operation and may occur with the archive action only in an explicitly enabled environment.

1. Open the exact project and review its current lifecycle and deployed-membership state.
2. Use the supported archive/unpublish control for the approved environment and read the consequence statement.
3. Enter the required reason/acknowledgement and submit once.
4. Confirm the resulting lifecycle, public-feed membership, audit, and publishing history.
5. Do not delete public or private media manually. Retention/deletion is an institutional policy decision.

For a bounded bulk archive, use **Projects** and select only the current page. A batch accepts at
most 50 selected rows. Review the displayed Local, Staging, or Production target and the exact
count/list, enter one required reason, acknowledge feed removal, and confirm once. Qualified
Published rows are sent sequentially through the same per-project archive control; this is not an
atomic all-or-nothing change. Keep completed and already-completed/no-change results with any
ineligible, denied, failed, unknown, and not-attempted rows. Stop on recovery, writer conflict,
feed divergence, target/auth loss, or an ambiguous timeout/network result and inspect current
state before explicitly selecting and confirming any retry. The batch never resumes itself. A
120-project cohort therefore requires three separately authorized batches of 50, 50, and 20.
The displayed target is **Local test-showcase feed**, **Staging test-showcase feed**, or
**Production live feed**; use **Review archive batch**, the required **Shared archive reason**,
and the displayed **Confirm and archive** action. Server state is authoritative. An **Unknown**
result stops the batch; later rows are **Not attempted**, with no automatic retry.
Original assets remain stored. Production is unavailable until separate institutional enablement
and exact runtime identity checks pass; an enabled production removal changes the live feed, while
verification of the Duda presentation remains a separate operator step.

### Restore an archived project

Use the archived project's **Restore project** action only after checking archive provenance and current public-feed state. This lifecycle restore is not a **Publishing** historical-feed rollback. A published-origin/currently public project requires canonical removal and verified absence from the feed first; restore returns it to **Approved**, revokes old preview authority, and requires a fresh preview, participant confirmation, and normal publication readiness/publication. It never republishes automatically; never reuse an old preview link. A non-published archive returns to its verified non-public review state. Stop on provenance or removal warnings and escalate.

### Soft-delete a project

Only active administrators can soft-delete projects. Soft delete is separate from archive/restore and performs no physical deletion. Published or currently public projects must complete canonical archive/removal first; previously published projects require exact completed-removal evidence. On one project, choose **Delete project**, wait for eligibility, read **Soft-delete this project?**, then use **Confirm soft delete** only for the exact eligible project. It changes lifecycle to Deleted and hides it from normal staff workflows but retains the project row, media/Storage, participant evidence, and all project history (publication/removal history, feed versions, and audit history). Deleted projects cannot be edited, reviewed, published, or restored through archive restore.

For multiple rows, choose **Delete selected projects** and **Review delete batch**. Server preflight labels each row **Eligible**, **Already soft-deleted**, or **Ineligible**; only eligible rows are attempted. The panel allows up to 50 and requires the exact list plus retained-history acknowledgement before choosing the displayed **Confirm and soft-delete** action. Processing is sequential with no automatic retry. **Unknown** stops the batch and later rows are **Not attempted**. Refresh and inspect project/audit state before any intentional retry.

Hosted application/database/Storage rollback is not the **Publishing** restore control. Historical-feed restoration is implemented only for explicitly enabled disposable Local or verified staging with the required database capability and exact-head evidence. It creates a new exact feed version and does not reverse project lifecycle or audit records. Production/Duda rollback remains unavailable.

## Assistive Checks

Assistive Checks read the poster document and suggest possible issues: a title that does not match
the poster, formatting problems, spelling and grammar suggestions, and projects that may be
duplicates.

They are **suggestions only**. They cannot approve a project, publish anything, or change project
information on their own. Staff review remains the authority. Assistive availability is nevertheless a required operational feature, so record and report processing outages rather than treating them as completed checks.

- Open a project and select **Run checks**. Results appear on the same page when processing finishes.
- Review each finding and mark it reviewed or dismissed as appropriate. When content needs correction, request a corrected project-team package; assistive suggestions do not directly rewrite participant-owned content.
- Earlier results stay readable at all times, including while checks are unavailable.

Sometimes the control is disabled and the page explains why:

| What the page says | What it means | What to do |
| --- | --- | --- |
| Assistive checks are temporarily unavailable because the processing worker is not ready | Processing is not currently available | Continue reviewing and editing normally. Try again later. Tell the technical maintainer if it lasts more than a working day |
| Assistive checks have reached their processing limit for now | The platform runs assistive processing a fixed number of times each month to stay within its free allowance | Continue reviewing and editing normally. Tell the technical maintainer if this happens regularly, because the limit may need reviewing |

Neither message blocks any part of your work. You can still import, validate, review, request/accept corrected packages, preview,
approve, and publish. **Never wait for assistive checks before approving a project** — deterministic
validation and your own review are the authority.

## Inspect history and failures

- Project history/audit evidence is available on the project detail workflow.
- Import status and project readiness are available in **Imports** and its batch detail page.
- Deployment versions, exact hashes/counts, membership, lifecycle/deployment drift, and blocking public-feed recovery state are available under **Publishing**.
- A `RECOVERY_REQUIRED` or **Publishing recovery available** message means an administrator must use the supported bounded recovery control for that exact operation. Do not publish, remove, restore, or edit Storage in parallel.

For any controlled operation failure:

1. Save the time, environment, safe project/batch public reference, visible bounded code, and action attempted.
2. Refresh the authoritative page once to determine whether the operation completed, is blocked, or requires recovery.
3. Do not blindly repeat an action after a timeout or unknown write outcome.
4. Escalate with the safe evidence. Never include raw errors, tokens, private URLs, user identifiers, or environment values.

## Authority and escalation

| Situation | Routine staff action | Escalate to |
| --- | --- | --- |
| Permission denied / missing navigation | Stop; record route and action | Staff-account administrator |
| Import invalid or warning | Correct source or acknowledge a reviewed warning | Content/process owner if source is uncertain |
| Stale/concurrent project | Refresh and reassess | Technical owner if repeated |
| Readiness/configuration/dependency unavailable | Stop controlled changes | Deployment authority and Supabase administrator |
| Participant email disabled/unknown | Use approved no-email workflow or stop | Email/provider owner |
| Publication preparation blocked | Resolve the displayed workflow evidence | Reviewer/content owner |
| Publication timeout, drift, or `RECOVERY_REQUIRED` | Stop all public-feed actions | Publication/Duda owner and recovery lead |
| Suspected data loss, missing Storage, wrong environment, or public exposure | Stop immediately | Recovery lead and incident escalation contact |
| Need to change staff access, provider settings, DNS, secrets, migrations, Render, Supabase, or Duda | Do not perform as routine staff | Named institutional authority |

Names and support routes are filled in through [Operational Handover and Training](operational-handover-and-training.md). Until assigned, the status is `TBD — STAKEHOLDER DECISION REQUIRED`.

## Routine completion evidence

For training or UAT, record only whether the task was completed unaided, completed with assistance, or not completed; safe task references; start/end time; and bounded observations. Use the KPI-15 instrument rather than inventing a result. The existence of this guide does not prove staff training or acceptance.
