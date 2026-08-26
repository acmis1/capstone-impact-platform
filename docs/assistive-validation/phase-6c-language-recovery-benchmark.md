# PP1 Phase 6C spelling and grammar recovery benchmark

## Decision and boundary

Phase 6C re-evaluates Harper 2.7.0 and LanguageTool 6.6 through a calibration-only policy-development, policy-freeze, and genuinely fresh one-shot holdout protocol. It does not production-integrate either engine, change the Admin/CMS, alter the assistive coordinator, add persistence, modify the lexical duplicate shortlist, or create a database migration.

The compact final evidence is [phase-6c-report.json](evidence/phase-6c-report.json). Both candidate decisions are explicit:

- **Harper 2.7.0: DEFER.** Holdout precision 61.5%, recall 40.0%, F1 48.5%, TP=8, FP=5, FN=12, with 17/20 clean cases silent.
- **LanguageTool 6.6: DEFER.** Holdout precision 61.5%, recall 40.0%, F1 48.5%, TP=8, FP=5, FN=12, with 16/20 clean cases silent.

Neither candidate meets the frozen 90% precision gate. No post-holdout tuning or second measurement occurred.

## Repository and freeze identity

| Item | Value |
|---|---|
| Starting protected `origin/main` | `6e0793472e4848ab5b467da70762dce6ebe828f1` |
| Branch | `feat/assistive-language-recovery-benchmark` |
| Policy-freeze Commit A | `86847ebd820a80e51ad4ffe99449670ee8d81db2` |
| Canonical policy SHA-256 | `60d3377b6d24ecbe8d6adf2b34b0c92bf2f930ac4729107b7eb9b27c61a5e1d6` |
| Frozen policy-file SHA-256 | `e7e84ac2f981d3f1a1634b2c9271f08e9ec76ef0966788606a688bb60b9ddf87` |
| Frozen 24-file tree SHA-256 | `7dc09743b74938899e9e0685054a2f54490ae7172962e324da96ea6ccb5e3444` |
| Calibration corpus SHA-256 | `9aaaba512b83cfbbf38e502009c8e7cff12019e9b62bf1a2eb2467b337f617b7` |
| Fresh holdout SHA-256 | `d8cb32ac9486a5ec84938122103ccf1b7a395c3426e9c516415a43ffc8f44782` |
| Final evidence SHA-256 | `1ddb69acd02ba05ed48db1ce9012993ac2b50a5c20a1c7bf6eed4cfcf9da72dc` |

Commit A contains the complete policy, provenance validator, mask contract, field policy, issue matcher, scorer, selection thresholds, engine versions/configuration, evidence schema, tests, calibration corpus, and calibration evidence. The following paths do not exist at Commit A and are checked mechanically with `git cat-file`:

- `tools/assistive-validation-benchmark/phase6c/corpus/holdout.json`;
- `docs/assistive-validation/evidence/phase-6c-report.json`;
- `docs/assistive-validation/phase-6c-language-recovery-benchmark.md`.

The final runner compares every frozen working-tree blob with Commit A using Git's path filters. A changed policy/scorer/matcher/candidate/evidence file fails before engine execution. The final run used an exclusively created one-shot state file, which records `final_measurement_number=1`, Commit A, the policy hash, completion, and the final evidence hash.

## Calibration and frozen policy

The calibration corpus contains 80 cases: all 40 existing Phase 6A calibration cases plus 40 new synthetic Phase 6C cases. The new cases contain 20 clean and 20 erroneous examples and cover all 16 required spelling, grammar, punctuation, and capitalisation families.

The vocabulary contains 25 exact case-sensitive terms: 16 with literal trusted-repository provenance, 9 declared in calibration cases, and 0 from holdout material. Only `REPOSITORY` and `CALIBRATION` provenance are accepted. Repository sources under benchmark/evidence/Prototype paths are rejected; calibration sources must resolve to a declared calibration case containing the term.

The field and masking policy is frozen as follows:

- title: spelling findings only;
- summary, background, and solution: spelling, grammar, punctuation, and capitalisation;
- offset-preserving masks: fenced/inline code, URLs, emails, RFC-4122 UUIDs, dotted filenames, and database identifiers;
- findings overlapping masked spans are discarded;
- vocabulary suppression applies only to an exact source span reported as spelling;
- issue matching retains the Phase 6A 50%-of-shorter-span overlap, accepted-correction intersection, zero-width punctuation tolerance, and one-TP-per-truth convention.

One LanguageTool rule is excluded: `SINGULAR_NOUN_ADV_AGREEMENT`. Across all 80 calibration cases it produced one mislocalised false positive and zero true positives. Other retained LanguageTool rules still detected labelled number/agreement errors. No category is disabled, Harper has no rule/kind exclusion, and spelling, grammar, punctuation, and capitalisation coverage remains enabled.

The selection rule is unchanged in substance from Phase 6A: at least 90% precision and at least 40% recall are required, preventing a checker that reports almost nothing from obtaining a trivial selection. At most one candidate may be selected, ordered by precision, recall, fewer false positives, then lower p95 latency.

### Calibration metrics after the complete policy

| Candidate | Precision | Recall | F1 | TP | FP | FN | Clean silence |
|---|---:|---:|---:|---:|---:|---:|---:|
| Harper 2.7.0 | 94.4% | 42.5% | 58.6% | 17 | 1 | 23 | 40/40 |
| LanguageTool 6.6 | 90.9% | 50.0% | 64.5% | 20 | 2 | 20 | 40/40 |

Calibration success did not authorize selection; it only froze the recovery policy for independent measurement.

## Fresh holdout

The holdout contains 40 entirely new synthetic cases: 20 clean and 20 erroneous. It covers title, summary, background, and solution; all 16 required error families; clean Australian prose; passive and compound prose; valid masked code/URL/email/UUID/filename/database-identifier spans; and legitimate unseen technical terms including Redis, Grafana, OpenSearch, Prometheus, RabbitMQ, Pydantic, SvelteKit, and GraphQL. Those terms were deliberately not added to the frozen vocabulary.

Normalised SHA-256 comparison collapses whitespace and case but preserves Unicode. The check compared the holdout with 108 unique exposed texts (18 Phase 0 grammar holdout texts, 50 locked Phase 6A v2/v3 texts, and 40 Phase 6A v4 texts) plus all 80 calibration texts:

| Non-reuse check | Result |
|---|---:|
| Prior/exposed texts checked | 108 |
| Calibration texts checked | 80 |
| Fresh holdout texts checked | 40 |
| Prior/exposed matches | 0 |
| Calibration matches | 0 |
| Within-holdout duplicates | 0 |

## Candidate and runtime identities

| Candidate | Frozen artifact and configuration | Measured runtime |
|---|---|---|
| Harper 2.7.0 | `harper.js` 2.7.0, package-lock SHA-256 `52e2dcb26c1ed3d79da348f9b86d5a1cbf32609d500da767c3f2e065910e8386`, Australian dialect, plaintext, local inlined WASM | Node `v24.14.1`; cold 1,118.2 ms; p50 3.0 ms; p95 4.8 ms; peak 469,286,912 bytes |
| LanguageTool 6.6 | official `LanguageTool-stable.zip`, SHA-256 `53600506b399bb5ffe1e4c8dec794fd378212f14aaf38ccef9b6f89314d11631`; extracted server-jar SHA-256 `f5279d946d901c90c0bb09cddaa6fdea8b26db9c548145d09041e8d1ac2d2b45`; `en-AU`, 25,000-character bound, 10-second check bound, one thread, loopback only | OpenJDK `21.0.12`; cold 16,785.8 ms; p50 47.5 ms; p95 114.4 ms; peak 846,700,544 bytes |

Both measurements used Python 3.12.13 on `Windows-11-10.0.26200-SP0`, CPU only. The final runner verified the complete LanguageTool archive hash and proved the extracted server jar matched the frozen archive member before starting the loopback server. No network grammar API or LLM judge was used.

## Fresh-holdout results and error analysis

| Candidate | Precision | Recall | F1 | TP | FP | FN | Clean silence | Decision |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Harper 2.7.0 | 61.5% | 40.0% | 48.5% | 8 | 5 | 12 | 17/20 | **DEFER** |
| LanguageTool 6.6 | 61.5% | 40.0% | 48.5% | 8 | 5 | 12 | 16/20 | **DEFER** |

Harper's false positives were one wrong-correction spelling report on the real typo `ingestorr`, one mass-noun agreement misfire on `finding`, and three legitimate unseen technical terms (`RabbitMQ`, `Pydantic`, `SvelteKit`). LanguageTool's false positives were the same wrong-correction spelling report plus four legitimate unseen tokens (`Redis`, `OpenSearch`, `loopback`, `Pydantic`). The frozen vocabulary generalised better than Phase 6A but did not eliminate the unseen-technical-token burden.

Both engines missed the same 12 truth issues: three subject/verb agreement, two singular/plural, and one each of repeated-character spelling, real-word spelling, pronoun agreement, possessive, sentence fragment, introductory comma, and comma splice. The result therefore shows two independent limitations: precision remains vulnerable to novel technical tokens and wrong replacement suggestions, while recall remains weak for representative grammar and punctuation families.

## Evidence validation and safety boundary

The evidence validator rejects unexpected keys and mechanically fails on holdout-derived or invalid vocabulary, changed frozen blobs/tree hash, reused holdout text, engine/version/artifact/configuration mismatch, missing candidate execution, inconsistent per-case/aggregate arithmetic, altered selection decisions, and crossed production boundaries. Metrics are recomputed from the per-case TP/FP/FN records.

Confirmed boundaries:

- production language integration: **NO**;
- production TypeScript/Admin/CMS/coordinator changes: **NO**;
- lexical duplicate shortlist modification or re-evaluation: **NO**;
- database migration: **NO**;
- hosted Supabase access: **NO**;
- Render access: **NO**;
- Duda access or modification: **NO**;
- teammate-owned UI, media, release-evaluation, and publication surfaces modified: **NO**;
- cloud AI, external grammar API, LLM judge, or real participant data: **NO**.

## Reproduction commands

From `tools/assistive-validation-benchmark`, with `PYTHONPATH=src` and the exact local archive/jar paths supplied:

```powershell
python -m assistive_validation_benchmark.phase6c check-calibration
python -m assistive_validation_benchmark.phase6c check-calibration-evidence
python -m assistive_validation_benchmark.phase6c check-freeze-manifest
python -m assistive_validation_benchmark.phase6c check-freeze-record
python -m assistive_validation_benchmark.phase6c check-final-evidence
python -m unittest tests.test_phase6c tests.test_phase6 -v
git diff --check
```

The focused suite passed all 59 Phase 6/6C tests. The complete benchmark discovery ran 347 tests: 334 passed and 13 unrelated OCR checks failed because this Windows checkout changes historical LF byte hashes and the available Python 3.12/pypdfium2 pair is not the OCR benchmark's pinned renderer. The base corpus validator, all four existing Phase 6 validators, all five Phase 6C evidence gates, and `git diff --check` passed. No grammar engine was rerun during evidence verification.

The executed calibration and final commands were:

```powershell
$env:PYTHONPATH = 'src'
$python = 'C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$archive = 'D:\IT RMIT\capstone-impact-platform-assistive-benchmark\tools\assistive-validation-benchmark\artifacts\languagetool\LanguageTool-stable.zip'
$jar = 'D:\IT RMIT\capstone-impact-platform-assistive-benchmark\tools\assistive-validation-benchmark\artifacts\languagetool\LanguageTool-stable-extract\LanguageTool-6.6\languagetool-server.jar'

& $python -m assistive_validation_benchmark.phase6c run-calibration `
  --languagetool-archive $archive `
  --languagetool-jar $jar `
  --output phase6c/calibration-evidence.json

& $python -m assistive_validation_benchmark.phase6c run-final `
  --freeze-commit 86847ebd820a80e51ad4ffe99449670ee8d81db2 `
  --languagetool-archive $archive `
  --languagetool-jar $jar `
  --output-dir artifacts/phase6c-final-once `
  --evidence-output ../../docs/assistive-validation/evidence/phase-6c-report.json
```

## Next evidence-backed step

Do not integrate either candidate. A future benchmark should first develop, on calibration only, a general technical-token policy that is not a hand-curated list of holdout failures—for example a mechanically sourced repository/domain glossary plus bounded casing/token-shape handling—and separately investigate a local grammar challenger or rule configuration with demonstrably better agreement/punctuation recall. Freeze that complete challenger policy before creating another fresh holdout. Productionisation remains a separate PR only after a candidate meets the frozen selection contract.
