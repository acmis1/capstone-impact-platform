# Admin/CMS Operator Guide

This guide is for school staff performing routine Admin/CMS work. It describes the current controlled workflow without database access, terminal commands, or bypasses. Environment-specific publishing, staff provisioning, recovery, and cloud administration require the authority named in the handover matrix.

## Before starting

- Use the institution-provided Admin/CMS address and staff account. Do not use the historical `Prototype/` application.
- Confirm the page identifies the intended test/staging environment before making a controlled change.
- Use only approved synthetic data in staging. Follow institutional privacy policy in any later production environment.
- If the service displays a permission, configuration, readiness, recovery, or identity error, stop and use the escalation table below.
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

- Correct source data through the supported import or metadata controls, then rerun the normal readiness action.
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

## Participant preview lifecycle

1. A project must be approved before a participant preview can be generated.
2. Review the exact preview content before generating or sending a link.
3. Choose the supported preview action. Email delivery, if available, is separately configured and may be disabled.
4. The participant either confirms that exact preview or submits a correction request; these outcomes are mutually exclusive.
5. If a correction is requested, an authorized staff member starts controlled resolution, edits through supported controls, obtains reapproval, and issues a new preview. Do not reuse or reconstruct an old preview link.
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

## Archive or unpublish

Archiving changes the project lifecycle. Removing a project from the deployed feed is a controlled writer operation and may occur with the archive action only in an explicitly enabled environment.

1. Open the exact project and review its current lifecycle and deployed-membership state.
2. Use the supported archive/unpublish control for the approved environment and read the consequence statement.
3. Enter the required reason/acknowledgement and submit once.
4. Confirm the resulting lifecycle, public-feed membership, audit, and publishing history.
5. Do not delete public or private media manually. Retention/deletion is an institutional policy decision.

Hosted rollback of application/database/Storage is not the **Publishing** restore control. Disposable-Local feed restoration only creates a new exact feed version and does not reverse project lifecycle or audit records.

## Assistive Checks

Assistive Checks read the poster document and suggest possible issues: a title that does not match
the poster, formatting problems, spelling and grammar suggestions, and projects that may be
duplicates.

They are **suggestions only**. They cannot approve a project, publish anything, or change project
information on their own. You decide what to accept. The platform works completely without them.

- Open a project and select **Run checks**. Results appear on the same page when processing finishes.
- Review each finding and either apply it, dismiss it, or leave it. Your decision is recorded.
- Earlier results stay readable at all times, including while checks are unavailable.

Sometimes the control is disabled and the page explains why:

| What the page says | What it means | What to do |
| --- | --- | --- |
| Assistive checks are temporarily unavailable because the processing worker is not ready | Processing is not currently available | Continue reviewing and editing normally. Try again later. Tell the technical maintainer if it lasts more than a working day |
| Assistive checks have reached their processing limit for now | The platform runs assistive processing a fixed number of times each month to stay within its free allowance | Continue reviewing and editing normally. Tell the technical maintainer if this happens regularly, because the limit may need reviewing |

Neither message blocks any part of your work. You can still import, edit, validate, review, preview,
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
