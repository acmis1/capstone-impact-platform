# PP1 Phase 7: local spelling and grammar production integration

## Selected provider and evidence basis

The frozen Phase 7 qualification selected **LanguageTool 6.6** for one bounded role: optional,
non-authoritative spelling and grammar suggestions for staff review. On the fresh sealed 96-case
holdout it recorded 25 true positives, 2 false positives, and 24 missed issues: 92.59% precision,
51.02% recall, and 65.79% F1. The frozen final gates were 90% precision and 40% recall. Harper 2.7
remains deferred because it did not clear the calibration eligibility margin.

The calibration, freeze, one-shot state, final evidence, non-reuse proof, and decision arithmetic
remain in the Phase 7 benchmark files. Production code does not alter or regenerate them.

## Runtime boundary

LanguageTool is disabled unless an operator supplies both environment variables:

- `CAPSTONE_ASSISTIVE_LANGUAGETOOL_ARCHIVE`: path to `LanguageTool-stable.zip` with SHA-256
  `53600506b399bb5ffe1e4c8dec794fd378212f14aaf38ccef9b6f89314d11631`.
- `CAPSTONE_ASSISTIVE_LANGUAGETOOL_JAR`: path to the extracted
  `LanguageTool-6.6/languagetool-server.jar` with SHA-256
  `f5279d946d901c90c0bb09cddaa6fdea8b26db9c548145d09041e8d1ac2d2b45`.

Both paths must be configured together. The application never downloads, extracts, or updates the
artifact. Java 17 or newer must be available on the worker host. A configured provider launches one
transient LanguageTool server per claimed project, binds it only to an ephemeral IPv4 loopback
port, sends only the four bounded prose fields, and terminates the child after the check.

Startup is capped at 45 seconds and each field request at 10 seconds. Server configuration caps text
at 25,000 characters, check time at 10 seconds, and check threads at one. Each response is capped at
256,000 bytes, stderr at 16,384 bytes, raw matches at 100 per field, retained findings at 10 per
field and 20 per project, suggestions at three, and each suggestion at 100 Unicode code points.
Grammar findings may retain zero replacements; spelling findings require one to three plausible
replacements. Raw provider responses, URLs, credentials, model traces, and arbitrary external
references are not persisted.

The coordinator pulses the existing fenced job claim before provider work and between fields.
Cancellation and claim loss stop finalization. Startup failure, timeout, malformed output, version
mismatch, artifact mismatch, Java failure, or process crash produces a truthful `PARTIAL` result
with `LANGUAGE_PROVIDER_UNAVAILABLE`; existing title, extraction, formatting, OCR, and duplicate
findings are retained. If OCR is also unavailable the combined completion code is
`OCR_AND_LANGUAGE_INCOMPLETE`. A disabled provider does not degrade existing deployments.

## Frozen policy reproduced in production

Production policy identity is SHA-256
`3984b958741a5103791524d48ba262a81ef829695ddc122a728c12cc3e689148` and pipeline identity is
`assistive-deterministic-checks/v3`.

The policy masks fenced and inline code, URLs, email, UUIDs, hashes, paths, dotted filenames or
database identifiers, semantic versions, environment/snake identifiers, and camel-case identifiers
with spaces. Masking preserves LanguageTool's UTF-16 code-unit length. Provider offsets are rejected
if they exceed a field or split a surrogate pair, then converted to canonical
`UNICODE_CODE_POINTS` before persistence.

Title checks retain spelling suggestions only. Summary, background, and solution may retain
spelling, grammar, punctuation, capitalization, and repeated-word suggestions. Exact approved
technical terms suppress spelling findings. A unique distance-one approved technical near miss uses
only that approved term as its replacement; other technical-looking tokens are suppressed. Ordinary
spelling suggestions must pass the frozen Damerau-Levenshtein, whitespace, punctuation, uniqueness,
and size tests after the first three bounded provider replacements are selected. Grammar findings
remain visible when the provider supplies no safe replacement. Provider messages are bounded,
control-sanitized, stored as plain-text explanations, and rendered only as text. The local provider
has no post-holdout rule exclusion.

## Persistence and staff UI

Migration `20260828090000_assistive_language_findings.sql` adds the closed
`assistive-finding-evidence/v3` shape. It stores the affected field, canonical start/end offsets,
exact original source span, bounded context, category, rule, provider/version, zero to three
suggestions (at least one for spelling), explanation, input hash, pipeline version, and policy hash. Database constraints and
the finalization RPC reject unexpected keys, incoherent language metadata, invalid spans,
unbounded/control-bearing text, an identity mismatch, or authority-bearing values. Existing v1 and
v2 evidence remain closed and compatible.

The staff interface renders every value as plain text and groups the finding by metadata field.
Each retained replacement has its own **Apply to draft** control. Apply is enabled only for a CURRENT
run and editable metadata. It rechecks that the entire affected field is still the version inspected
and that the exact Unicode code-point span still matches, replaces only that span, focuses the
affected editor field, and marks the draft dirty. It never calls the save action. Findings without a
safe replacement show no Apply control. Staff must still select **Save metadata**, which uses
the existing authoritative audit path. **Mark reviewed** and **Ignore** remain the only durable
finding dispositions.

Saving relevant metadata changes the existing assistive input hash, so the inspection becomes
STALE and its Apply controls are disabled until staff explicitly run checks again.

## Migration sequencing and deployment status

The migration timestamp is later than the still-open draft PR 204 migration
`20260826090000_public_feed_activation_authority_guard.sql`. This branch contains 44 migrations
because PR 204 is not part of its base; after both streams land, the reconciled inventory will be 45
and the exact migration inventory/count assertions must be resolved in the later integration.

This change does not apply hosted Supabase migrations, configure Render, modify Duda, or provision a
production LanguageTool artifact. Those remain separately authorized deployment operations.
