# Stakeholder and Constrained Human-Evidence Audit — 2026-09-08

## 1. Purpose and evidence boundary

This audit records the human evidence currently available for the project and
the boundary between that evidence and formal human KPI acceptance. It
maximises the defensible use of existing stakeholder and academic-supervisor
evidence without fabricating UAT, training, staff effort, ownership transfer,
or acceptance.

The status vocabulary used here is deliberate:

| Status | Meaning |
| --- | --- |
| `HISTORICAL_STAKEHOLDER_REQUIREMENT_FEEDBACK` | Earlier industry feedback that establishes needs, constraints, or concerns. It is not final UAT. |
| `HISTORICAL_INDUSTRY_USABILITY_AND_SCALE_FEEDBACK` | Earlier industry feedback about usability, scale, maintainability, media, or workflow burden. It is not final UAT. |
| `REQUIREMENT_RESPONSE_VERIFIED` | The repository contains technical implementation and evidence responding to a recorded concern. It is not stakeholder acceptance. |
| `ACADEMIC_SUPERVISOR_DEMONSTRATION_FEEDBACK` | Expert observation or feedback during a demonstration. It is not intended-user UAT or ownership transfer. |
| `FORMAL_INTENDED_USER_UAT_PENDING` | The original intended-user task-based UAT contract has not been completed. |
| `HUMAN_TRAINING_AND_OWNERSHIP_PENDING` | The formal documentation-based training and institutional ownership contract has not been completed. |
| `TECHNICAL_EVIDENCE_VERIFIED` | A bounded technical or machine-evaluated result is recorded. It does not prove human acceptance. |

No source below is treated as final stakeholder or production acceptance, a
passed KPI, or a passed-with-accepted-limitation release classification.

## 2. Deadline and stakeholder-availability constraint

The deadline is close and exhaustive feature-by-feature staff UAT/training
cannot be relied on. The current state is therefore:

`HUMAN_EVIDENCE_CONSTRAINED`

This constraint does not invalidate the completed technical evidence. It limits
only claims that require intended-user participation, comparable staff timing,
formal training, institutional ownership, or final stakeholder acceptance.

## 3. R1 trigger and active mitigation

Completion Plan risk R1 concerns delayed stakeholder decisions, system access,
or UAT participation. That risk is now:

| Risk | Current state | Mitigation |
| --- | --- | --- |
| R1 — stakeholder decisions, access, or UAT participation may be delayed | `R1_TRIGGERED` | `MITIGATION_ACTIVE` — preserve the decision/evidence boundary, use existing requirements feedback, keep technical evaluation moving with synthetic data, and use the abbreviated contingency instrument if a short intended-user session becomes available. |

R1 is not closed. The project should continue technical M6 work that does not
require human participation while separately requesting the smallest useful
stakeholder session.

## 4. Historical stakeholder requirement evidence

### Early industry stakeholder — Duda and scale requirement

Source: `Capstone Stakeholder 1.txt`, approximately 19:26–30:54;
role: industry stakeholder; classification:
`HISTORICAL_STAKEHOLDER_REQUIREMENT_FEEDBACK`.

The stakeholder feedback recorded that a Duda subscription upgrade was not
preferred, the existing internal collection was limited to roughly ten rows,
and the team needed to explain what would happen at project 11 and beyond.
The proposed dynamic approach was challenged as potentially retaining manual
work, with further investigation and another approach requested.

This supports the no-upgrade constraint, the need to move beyond a
10-record/manual workflow, the scalability requirement, and the rationale for
a hybrid architecture. It does not establish final usability acceptance,
satisfaction of at least 4/5, final UAT, or release sign-off.

### 21 May industry workflow feedback

Source: `Capstone 21 5  2026.srt`, approximately 19:53–20:38,
23:13–27:28, and 35:20–35:41; role: industry stakeholder(s); classification:
`HISTORICAL_INDUSTRY_USABILITY_AND_SCALE_FEEDBACK`.

The then-current prototype was reported as requiring too much manual handling.
Code-oriented steps were considered unsuitable for non-technical users. The
feedback also raised long-term maintainability over roughly 5–10 years,
possible annual cohorts of about 100 and potentially 200–300 projects, media
and file-volume checks before real data, and retaining PDF poster downloads.

This supports batch import, an XLSX/non-technical workflow, reduced manual
page reconstruction, maintainability, higher-volume verification, media
capacity consideration, and continued PDF/public media functionality. It does
not establish final UAT or acceptance.

## 5. Academic-supervisor demonstration evidence

### Direction to deploy before stakeholder testing

Source: `Advisor_14_08.srt`, approximately 21:46–24:24 and 27:38–27:49;
role: academic supervisor; classification:
`ACADEMIC_SUPERVISOR_UAT_DIRECTION`.

The supervisor directed the team to deploy the workflow, send it to industry
stakeholders for usage/advice/feedback, and invite a brief test when ready.
The direction explicitly favoured waiting until the deployed workflow was
ready. This proves that stakeholder testing was intended and planned; it does
not prove that the intended-user test subsequently occurred.

### 21 August demonstration

Source: `2026-08-21_PP2_Capstone_SupervisorMeeting.docx`; role: academic
supervisor; classification: `HUMAN_DEMONSTRATION_FEEDBACK`.

The team demonstrated the application, discussed Render limitations, media
testing, and role/permission support, and received positive confirmation about
the displayed media after re-import. The next major priority was Admin/CMS →
Duda integration. That technical integration is now recorded separately in
the Duda TEST evidence package.

This was demonstration feedback, not intended-user UAT: the supervisor did
not independently complete all KPI-12 tasks, provide a 1–5 satisfaction
survey, complete KPI-15 training, or transfer institutional ownership.

### 28 August demonstration

Source: `Advisor_28_8.srt`, approximately 19:35–22:30; role: academic
supervisor; classification: `ACADEMIC_SUPERVISOR_DEMONSTRATION_FEEDBACK`.

The supervisor observed publication/removal behavior, saw the demonstrated
project disappear after archive/removal, and responded positively to the
overall workflow and folder import. Remaining comments were comparatively
minor workflow/UI matters, including duplicate controls and file-modification
handling.

This is meaningful human/expert review evidence, but it is not formal
intended-administrator UAT, a satisfaction survey, KPI-15 training, or
institutional ownership transfer.

## 6. Requirement-to-response traceability

| Stakeholder concern | Project response | Implementation / test evidence | Final human acceptance status |
| --- | --- | --- | --- |
| No Duda upgrade | Hybrid Admin/CMS → structured public feed → Duda TEST architecture | Data-backed Duda TEST sequence and controlled `0 → 1 → 0` feed/removal evidence in [`Duda TEST acceptance evidence`](duda-test-acceptance-evidence/2026-09-08/README.md) | Pending formal stakeholder acceptance |
| Ten-row / project 11+ scaling concern | External structured feed and reusable public pages | 120-project persisted corpus and 132-case Local evaluation; technical evidence is independently verified | Pending human scale/operational acceptance |
| Too much manual project-by-project work | Folder/batch import, XLSX, automated validation, and bulk review | Release evaluation and Admin/CMS workflow evidence | Historical requirement response verified; final UAT pending |
| Non-technical staff concern | Staff-facing browser workflow and XLSX rather than developer JSON | Import/review workflow and operator documentation exist | Formal intended-user UAT pending |
| Searchable, selectable, accessible content | Structured feed, public-field search/filter, and accessibility fields | Duda TEST search/facet/detail evidence and accessibility evidence verifier | Technical evidence verified; human acceptance pending |
| Long-term maintainability | School-owned source of truth, migration discipline, and operator/developer documentation | M6 readiness, handover, and maintenance documents | Institutional ownership transfer pending |
| Media limits and PDF support | Governed media validation/storage and supported public media/PDF handling | Media evidence and Duda TEST package describe bounded supported behavior | Formal stakeholder acceptance pending |
| Admin/CMS → Duda integration priority | Data-backed Duda TEST renderer and governed publication/removal boundary | Synthetic `0 → 1 → 0` Duda TEST acceptance sequence | Demonstration/technical evidence only; final acceptance pending |

`REQUIREMENT_RESPONSE_VERIFIED` means the response is evidenced in the
repository. It must not be read as final stakeholder acceptance.

## 7. KPI-01 — publishing workflow efficiency

Formal status: `NOT TESTED / PENDING COMPARABLE HUMAN MEASUREMENT`.

The project brief/proposal records a historical reference baseline of about,
or at least, two weeks of one staff member's work for a batch. That is
`REFERENCE_BASELINE_ONLY`: it supports the business problem and the
plausibility of savings, but it is not a comparable same-batch staff
measurement and must not be inserted into `T_manual` by itself.

The formal KPI remains:

`((T_manual - T_system) / T_manual) × 100`

using staff minutes for equivalent project batches and the unchanged threshold
of at least 50% reduction. Machine runtime, evaluator milliseconds, browser
timing, or Local harness timing must never be substituted for staff effort.
Use the existing [manual-efficiency template](templates/release-evaluation-manual-efficiency.md)
without pre-populating its result.

An optional `TEAM_PROXY_EFFICIENCY_EXERCISE` may compare a team member's old
manual workflow and new Admin/CMS workflow on the same small synthetic cohort.
If run, it is `TEAM_PROXY` and `NOT_FORMAL_KPI_01`; it does not change the
participant definition, threshold, or formal status. No proxy measurement is
generated by this audit.

## 8. KPI-12 — admin usability

Formal status: `FORMAL_INTENDED_USER_UAT_PENDING`.

KPI-12 requires intended users to complete all critical tasks—import,
correction, approval, publication, archive, and recovery—with average
satisfaction of at least 4/5 and minimal facilitator assistance. The required
UAT scripts, observations, completion results, and survey responses are not
yet a completed formal evidence set.

Historical industry requirements/usability feedback and academic-supervisor
demonstrations are valuable supplementary human evidence. They do not, by
themselves, satisfy the task-based UAT contract or justify a KPI-12 pass.
The abbreviated contingency instrument is supplementary and cannot weaken the
original threshold.

## 9. KPI-15 — documentation and handover

Formal status: `HUMAN_TRAINING_AND_OWNERSHIP_PENDING`.

KPI-15 requires at least 80% unaided routine-task completion by intended
administrators using the documentation and successful institutional ownership
transfer. The current repository contains the documentation and measurement
instrument, but the formal intended-admin task run, named ownership transfer,
credential ownership transfer, and final stakeholder sign-off are incomplete.

Demonstrations, deadline-constrained feedback, and any `TEAM_PROXY` exercise
do not substitute for the intended-admin unaided run or ownership transfer.
The existing [KPI-15 training instrument](operational-handover-and-training.md)
therefore remains `NOT RUN` where no formal run has occurred.

## 10. Technical evidence that remains valid independently of UAT

The following remain valid within their recorded scopes and are not relabelled
as human UAT, staff effort, ownership, or training evidence:

- M4/Duda TEST: repository renderer installed in the authorized TEST editor;
  populated listing, title/case-insensitive/public-ID/industry-partner/group
  search, four facets, search-plus-facet, detail navigation, populated mobile
  no-overflow, governed removal, and final canonical feed `[]` for one
  synthetic project.
- M5 machine release evaluation: two comparable complete Local runs with 132
  cases, 120 persisted, 12 deliberate rejects, zero unaccounted, critical
  seeded issues 32/32, non-critical seeded issues 20/20, controls 110/110,
  zero blocking false positives, and 180/180 audit rows.
- Accessibility evidence integrity verification: 112 files scanned, 57 text
  files, 54 screenshots, 54 unique hashes, and zero findings.
- Exact-head PR #273 CI and post-merge main CI: all jobs passed as recorded by
  the current evidence package.

These results support `TECHNICAL_EVIDENCE_VERIFIED` for their bounded
technical claims. They do not close R1 or the formal human KPI gaps.

## 11. Remaining formal human evidence

| KPI | Formal current evidence status | Supplementary evidence available |
| --- | --- | --- |
| KPI-01 | `NOT TESTED / PENDING COMPARABLE HUMAN MEASUREMENT` | Historical two-week `REFERENCE_BASELINE_ONLY`; optional `TEAM_PROXY` possible but not run |
| KPI-12 | `FORMAL_INTENDED_USER_UAT_PENDING` | Historical industry requirements/usability feedback and academic-supervisor demonstrations |
| KPI-15 | `HUMAN_TRAINING_AND_OWNERSHIP_PENDING` | Documentation and instrument complete; formal run and institutional transfer remain pending |

These are current evidence statuses, not a new final release classification.
If the project's final assessment convention later requires `FAILED` for
incomplete evidence, that final classification must remain distinct from this
current evidence record.

## 12. Deadline contingency

If an intended SSET staff member becomes available for only 10–15 minutes,
use the [abbreviated stakeholder UAT contingency](templates/abbreviated-stakeholder-uat-contingency.md)
with synthetic data only. Prioritise one short path through import, warning vs
blocker interpretation, correction/review/approval, publication authorization
boundary, archive/unpublish, and recovery/history guidance. Record every
facilitator intervention and collect the 1–5 satisfaction response.

An incomplete session is `SUPPLEMENTARY_STAKEHOLDER_FEEDBACK`, not KPI-12
passage. Do not replace the formal KPI-15 training instrument with this short
session. Technical M6 completion should continue independently wherever human
participation is not required.

## 13. Source provenance

Only short, role-based, sanitized paraphrases are recorded here. The complete
transcripts and meeting documents remain source material and are not copied
into the public repository.

| Source | Date / region | Role | Recorded classification |
| --- | --- | --- | --- |
| `Capstone Stakeholder 1.txt` | Historical; approximately 19:26–30:54 | Industry stakeholder | `HISTORICAL_STAKEHOLDER_REQUIREMENT_FEEDBACK` |
| `Capstone 21 5  2026.srt` | 2026-05-21; approximately 19:53–20:38, 23:13–27:28, 35:20–35:41 | Industry stakeholder(s) | `HISTORICAL_INDUSTRY_USABILITY_AND_SCALE_FEEDBACK` |
| `Advisor_14_08.srt` | 2026-08-14; approximately 21:46–24:24, 27:38–27:49 | Academic supervisor | `ACADEMIC_SUPERVISOR_UAT_DIRECTION` |
| `2026-08-21_PP2_Capstone_SupervisorMeeting.docx` | 2026-08-21 | Academic supervisor | `HUMAN_DEMONSTRATION_FEEDBACK` |
| `Advisor_28_8.srt` | 2026-08-28; approximately 19:35–22:30 | Academic supervisor | `ACADEMIC_SUPERVISOR_DEMONSTRATION_FEEDBACK` |
| `docs/duda-test-acceptance-evidence/2026-09-08/README.md` | 2026-09-08 | Technical/evidence record | `TECHNICAL_EVIDENCE_VERIFIED`; not human acceptance |
| `docs/release-evaluation-integration-audit.md` | 2026-09-08 current machine recheck | Technical/evidence record | `TECHNICAL_EVIDENCE_VERIFIED`; not human effort or UAT |

No private individual identifiers, private contact details, meeting URLs, preview tokens,
credentials, cookies, or unnecessary personal identifiers are included.
