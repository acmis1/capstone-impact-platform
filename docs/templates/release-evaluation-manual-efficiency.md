# Release Evaluation Manual Efficiency Template

Use this instrument to measure BRIEF-SC01 against one comparable project cohort. It records two independent outcomes:

1. end-to-end elapsed/cycle time; and
2. manpower measured as total human person-hours.

SC01 status: **NOT MEASURED / PENDING COMPARABLE HUMAN MEASUREMENT**. This blank instrument contains no achieved result. Test-suite runtime, browser-automation milliseconds, server execution time, and developer terminal runtime are not publishing elapsed-time or manpower evidence.

## 1. Measurement definition and comparability approval

Complete this section before either method starts. If the manual and system methods do not follow the same approved comparison contract, do not calculate or report SC01.

| Field | Agreed definition / evidence |
| --- | --- |
| Cohort / comparable project-set identifier |  |
| Project count (must be identical) |  |
| Starting artifacts (must be identical) |  |
| Seeded defects, if synthetic (must be identical) |  |
| Required completed output (must be identical) |  |
| Validation, review, correction, approval, and publication scope (must be identical) |  |
| Agreed start event |  |
| Agreed completion event |  |
| Waiting inclusion/exclusion policy (apply identically to both methods) |  |
| Participant competence and training assumptions |  |
| Method order and practice/familiarisation |  |
| Observer / evidence references (sanitized) |  |
| Comparability approved by / date |  |

Pre-measurement checklist:

- [ ] Same cohort or demonstrably comparable project set.
- [ ] Same project count.
- [ ] Same starting artifacts.
- [ ] Same seeded defects where synthetic.
- [ ] Same required completed output.
- [ ] Same validation, review, correction, approval, and publication scope.
- [ ] Same waiting inclusion/exclusion rule.
- [ ] Comparable participant competence and training assumptions.
- [ ] Exceptional interruptions will be recorded rather than silently removed.

Training or familiarisation is recorded separately and excluded from both measurements only when that exclusion is agreed in advance and applied equally.

## 2. End-to-end elapsed / cycle time

Use timestamps from the same agreed clock and timezone. Start both methods at the predefined start event and finish at the predefined completion event. Record raw elapsed time, then subtract only exclusions allowed by the shared policy. Externally unavoidable waiting must either be included for both methods or excluded for both methods; do not choose the more favourable rule after observing results.

| Method | Agreed start timestamp | Agreed completion timestamp | Raw elapsed minutes | Allowed excluded waiting / interruption minutes | Adjusted elapsed minutes | Evidence reference |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Current manual workflow |  |  |  |  |  |  |
| Admin/CMS system workflow |  |  |  |  |  |  |

Record corrections/rework, waiting, tool failure, external dependencies, assistance, and exceptional interruptions here. Each entry must say whether it is included or excluded under the predefined policy.

| Method | Event / activity | Start | End or minutes | Category | Included or excluded | Reason / evidence |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  | correction/rework, waiting, tool failure, external dependency, assistance, or interruption |  |  |

Calculation, only when `manual_elapsed > 0` and both adjusted durations exist:

`elapsed_time_reduction_pct = (manual_elapsed - system_elapsed) / manual_elapsed * 100`

| Elapsed-time result | Value |
| --- | ---: |
| Manual adjusted elapsed minutes |  |
| System adjusted elapsed minutes |  |
| Elapsed-time reduction percentage |  |
| Elapsed-time threshold (`>= 50%`) | `NOT MEASURED` |

## 3. Manpower / human labour

Record active human labour separately for every participant or observer role and workflow activity. Do not count unattended machine processing as labour. If a person must actively monitor, inspect, correct, retry, communicate, or assist, record those active minutes. Notes must identify corrections/rework, waiting, tool failure, external dependencies, and assistance from another person.

Use a stable anonymized participant label. Add rows as needed.

| Method | Participant / observer label | Role | Agreed workflow activity | Active minutes | Notes / exceptional event | Evidence reference |
| --- | --- | --- | --- | ---: | --- | --- |
| Manual |  |  | Collect package |  |  |  |
| Manual |  |  | Validate fields |  |  |  |
| Manual |  |  | Cross-check Admin reference |  |  |  |
| Manual |  |  | Inspect media and accessibility evidence |  |  |  |
| Manual |  |  | Review and request corrections |  |  |  |
| Manual |  |  | Process corrected material |  |  |  |
| Manual |  |  | Approve and prepare required publication output |  |  |  |
| System |  |  | Collect / intake package |  |  |  |
| System |  |  | Validate fields |  |  |  |
| System |  |  | Reconcile Admin reference |  |  |  |
| System |  |  | Inspect media and accessibility evidence |  |  |  |
| System |  |  | Review and request corrections |  |  |  |
| System |  |  | Review / accept corrected package |  |  |  |
| System |  |  | Approve and prepare required publication output |  |  |  |

Summarize by method. The primary manpower denominator is total person-hours; headcount is supporting context only.

`total_active_minutes = sum(active minutes for every participant and activity)`

`total_person_hours = total_active_minutes / 60`

Two people each working for 30 active minutes equal 60 active minutes, or 1.0 person-hour—not 30 minutes of manpower.

| Manpower result | Manual workflow | System workflow |
| --- | ---: | ---: |
| Total active minutes |  |  |
| Total person-hours |  |  |
| Headcount involved |  |  |

Calculation, only when `manual_person_hours > 0` and both totals exist:

`manpower_reduction_pct = (manual_person_hours - system_person_hours) / manual_person_hours * 100`

| Manpower decision | Value |
| --- | ---: |
| Manpower reduction percentage |  |
| Manpower threshold (`>= 50%`) | `NOT MEASURED` |

## 4. BRIEF-SC01 decision

SC01 passes only when both independently calculated thresholds pass:

`elapsed_time_reduction_pct >= 50% AND manpower_reduction_pct >= 50%`

- If either measurement is missing, the SC01 result is **NOT MEASURED**.
- If either reduction is below 50%, the SC01 result is **NOT PASSED**.
- Do not average the percentages and do not allow one result to compensate for the other.

| Decision field | Recorded result |
| --- | --- |
| Elapsed-time reduction percentage |  |
| Manpower reduction percentage |  |
| Final SC01 result (`PASS`, `NOT PASSED`, or `NOT MEASURED`) | `NOT MEASURED` |
| Observer conclusion and deviations |  |
| Independent reviewer / date |  |

No 50% reduction, KPI result, or SC01 pass is pre-populated by this template. A real manual-versus-system, same-cohort human comparison remains required.
