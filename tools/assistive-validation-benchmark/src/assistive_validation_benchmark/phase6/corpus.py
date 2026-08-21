from __future__ import annotations

import hashlib
import json
import random
from collections import Counter
from pathlib import Path
from typing import Any

PHASE6_SCHEMA_VERSION = 1
PHASE6_CORPUS_VERSION = "pp1-assistive-phase6a-v2"
PHASE6_SEED = 61062026
SPLITS = {"calibration", "holdout"}
FIELDS = {"title", "summary", "background", "solution", "extracted_text"}
RELATIONSHIPS = {"EXACT_DUPLICATE", "NEAR_DUPLICATE", "RELATED_NOT_DUPLICATE", "UNRELATED"}


def _issue_case(
    case_id: str,
    split: str,
    field: str,
    text: str,
    needle: str,
    category: str,
    corrections: list[str],
    *,
    legitimate_terms: list[str] | None = None,
) -> dict[str, Any]:
    start = text.find(needle)
    if start < 0 or text.find(needle, start + 1) >= 0:
        raise ValueError(f"{case_id} issue span must occur exactly once")
    return {
        "id": case_id,
        "split": split,
        "field": field,
        "source_text": text,
        "intentionally_clean": False,
        "legitimate_technical_terms": legitimate_terms or [],
        "issues": [{
            "start": start,
            "end": start + len(needle),
            "source": needle,
            "category": category,
            "accepted_corrections": corrections,
        }],
    }


def _clean_case(
    case_id: str,
    split: str,
    field: str,
    text: str,
    legitimate_terms: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "id": case_id,
        "split": split,
        "field": field,
        "source_text": text,
        "intentionally_clean": True,
        "legitimate_technical_terms": legitimate_terms or [],
        "issues": [],
    }


def _grammar_cases() -> list[dict[str, Any]]:
    errors = [
        _issue_case("g6-001", "calibration", "summary", "The sensr reports water pressure every minute.", "sensr", "SPELLING_ORDINARY", ["sensor"]),
        _issue_case("g6-002", "calibration", "solution", "A controlller closes the valve when pressure rises.", "controlller", "SPELLING_REPEATED_CHARACTER", ["controller"]),
        _issue_case("g6-003", "calibration", "background", "Weak authentcation exposed the dashboard to misuse.", "authentcation", "SPELLING_DROPPED_CHARACTER", ["authentication"]),
        _issue_case("g6-004", "calibration", "summary", "The gateway receives readings form each meter.", "form", "SPELLING_REAL_WORD", ["from"]),
        _issue_case("g6-005", "calibration", "solution", "The edge gateway transmit alerts over MQTT.", "transmit", "GRAMMAR_SUBJECT_VERB_AGREEMENT", ["transmits"], legitimate_terms=["MQTT"]),
        _issue_case("g6-006", "calibration", "background", "The audit logs contains duplicate events.", "contains", "GRAMMAR_SUBJECT_VERB_AGREEMENT", ["contain"]),
        _issue_case("g6-007", "calibration", "summary", "Three sensor monitor the loading bay.", "sensor", "GRAMMAR_SINGULAR_PLURAL", ["sensors"]),
        _issue_case("g6-008", "calibration", "solution", "The service uses database to retain inspection notes.", "database", "GRAMMAR_ARTICLE", ["a database", "the database"]),
        _issue_case("g6-009", "calibration", "background", "The robot completed their route before charging.", "their", "GRAMMAR_PRONOUN_AGREEMENT", ["its"]),
        _issue_case("g6-010", "calibration", "solution", "The recovery job has ran twice today.", "ran", "GRAMMAR_VERB_FORM", ["run"]),
        _issue_case("g6-011", "calibration", "summary", "Because the backup gateway lost power.", "Because the backup gateway lost power.", "GRAMMAR_SENTENCE_FRAGMENT", ["The backup gateway lost power.", "Because the backup gateway lost power, telemetry was delayed."]),
        _issue_case("g6-012", "calibration", "background", "After the restart the queue drained normally.", "After the restart", "PUNCTUATION_INTRODUCTORY_COMMA", ["After the restart,"]),
        _issue_case("g6-013", "calibration", "solution", "The probe detected smoke, it sent an alert.", "smoke, it", "PUNCTUATION_COMMA_SPLICE", ["smoke, and it", "smoke; it", "smoke. It"]),
        _issue_case("g6-014", "calibration", "summary", "The dashboard shows the the latest inspection.", "the the", "GRAMMAR_DUPLICATED_WORD", ["the"]),
        _issue_case("g6-015", "calibration", "background", "the gateway stores only deidentified readings.", "the", "GRAMMAR_CAPITALIZATION", ["The"], legitimate_terms=["deidentified"]),
        _issue_case("g6-016", "calibration", "summary", "The sensors readings are retained for seven days.", "sensors", "GRAMMAR_POSSESSIVE", ["sensor's", "sensors'"]),
        _issue_case("g6-017", "calibration", "solution", "The worker did not sent the failed record again.", "sent", "GRAMMAR_VERB_FORM", ["send"]),
        _issue_case("g6-018", "calibration", "background", "Each node report its battery level once an hour.", "report", "GRAMMAR_SUBJECT_VERB_AGREEMENT", ["reports"]),
        _issue_case("g6-019", "calibration", "solution", "Kubernetees schedules the local worker process.", "Kubernetees", "SPELLING_TECHNICAL_NEAR_MISS", ["Kubernetes"]),
        _issue_case("g6-020", "calibration", "summary", "The team built an unique flood warning prototype.", "an", "GRAMMAR_ARTICLE", ["a"]),
        _issue_case("g6-041", "holdout", "summary", "The monitro records vibration at the bridge joint.", "monitro", "SPELLING_ORDINARY", ["monitor"]),
        _issue_case("g6-042", "holdout", "solution", "The process writess one audit event per change.", "writess", "SPELLING_REPEATED_CHARACTER", ["writes"]),
        _issue_case("g6-043", "holdout", "background", "A dropped packet delayed notifcation delivery.", "notifcation", "SPELLING_DROPPED_CHARACTER", ["notification"]),
        _issue_case("g6-044", "holdout", "summary", "The operator can than compare both forecasts.", "than", "SPELLING_REAL_WORD", ["then"]),
        _issue_case("g6-045", "holdout", "solution", "The camera modules captures one image per hour.", "captures", "GRAMMAR_SUBJECT_VERB_AGREEMENT", ["capture"]),
        _issue_case("g6-046", "holdout", "background", "The ingestion service process new readings in batches.", "process", "GRAMMAR_SUBJECT_VERB_AGREEMENT", ["processes"]),
        _issue_case("g6-047", "holdout", "summary", "Five actuator regulate the greenhouse vents.", "actuator", "GRAMMAR_SINGULAR_PLURAL", ["actuators"]),
        _issue_case("g6-048", "holdout", "solution", "The prototype publishes result to a local dashboard.", "result", "GRAMMAR_SINGULAR_PLURAL", ["results", "a result"]),
        _issue_case("g6-049", "holdout", "background", "The server refreshed her certificate automatically.", "her", "GRAMMAR_PRONOUN_AGREEMENT", ["its"]),
        _issue_case("g6-050", "holdout", "solution", "The parser had broke on an empty document.", "broke", "GRAMMAR_VERB_FORM", ["broken"]),
        _issue_case("g6-051", "holdout", "summary", "While the primary link was unavailable.", "While the primary link was unavailable.", "GRAMMAR_SENTENCE_FRAGMENT", ["The primary link was unavailable.", "While the primary link was unavailable, the gateway buffered events."]),
        _issue_case("g6-052", "holdout", "background", "Before deployment the team rotated the test key.", "Before deployment", "PUNCTUATION_INTRODUCTORY_COMMA", ["Before deployment,"]),
        _issue_case("g6-053", "holdout", "solution", "The valve opened, the tank level fell.", "opened, the", "PUNCTUATION_COMMA_SPLICE", ["opened, and the", "opened; the", "opened. The"]),
        _issue_case("g6-054", "holdout", "summary", "The model compares each each daily estimate.", "each each", "GRAMMAR_DUPLICATED_WORD", ["each"]),
        _issue_case("g6-055", "holdout", "background", "all telemetry remains inside the laboratory network.", "all", "GRAMMAR_CAPITALIZATION", ["All"]),
        _issue_case("g6-056", "holdout", "summary", "The gateways status appears beside the device name.", "gateways", "GRAMMAR_POSSESSIVE", ["gateway's"]),
        _issue_case("g6-057", "holdout", "solution", "The scheduler does not retries completed tasks.", "retries", "GRAMMAR_VERB_FORM", ["retry"]),
        _issue_case("g6-058", "holdout", "background", "Neither backup route provide continuous coverage.", "provide", "GRAMMAR_SUBJECT_VERB_AGREEMENT", ["provides"]),
        _issue_case("g6-059", "holdout", "solution", "PostgreSQl stores the synthetic benchmark records.", "PostgreSQl", "SPELLING_TECHNICAL_NEAR_MISS", ["PostgreSQL"]),
        _issue_case("g6-060", "holdout", "summary", "The project provides a effective anomaly detector.", "a effective", "GRAMMAR_ARTICLE", ["an effective"]),
    ]
    clean_specs = [
        ("g6-021", "calibration", "summary", "The FastAPI service validates each bounded request locally.", ["FastAPI"]),
        ("g6-022", "calibration", "solution", "PostgreSQL retains the approved project metadata.", ["PostgreSQL"]),
        ("g6-023", "calibration", "background", "Kubernetes was evaluated, but a single local process was sufficient.", ["Kubernetes"]),
        ("g6-024", "calibration", "summary", "The TypeScript client renders a ranked shortlist for staff review.", ["TypeScript"]),
        ("g6-025", "calibration", "solution", "OpenTelemetry traces remain disabled in the offline benchmark.", ["OpenTelemetry"]),
        ("g6-026", "calibration", "background", "WebAuthn reduces reliance on reusable passwords.", ["WebAuthn"]),
        ("g6-027", "calibration", "solution", "Argon2id protects locally stored password verifiers.", ["Argon2id"]),
        ("g6-028", "calibration", "summary", "The WebRTC prototype exchanges media only on the laboratory network.", ["WebRTC"]),
        ("g6-029", "calibration", "background", "MQTT messages are buffered when the radio link is unavailable.", ["MQTT"]),
        ("g6-030", "calibration", "solution", "A Modbus adapter reads registers from the training rig.", ["Modbus"]),
        ("g6-031", "calibration", "title", "Sensor Gateway Architecture", []),
        ("g6-032", "calibration", "title", "Database Migration Plan", []),
        ("g6-033", "calibration", "summary", "The behaviour is correct for the colour-coded status panel.", []),
        ("g6-034", "calibration", "background", "Readings were collected passively because active polling overloaded the device.", []),
        ("g6-035", "calibration", "solution", "The event-driven ingestion pipeline uses bounded retries.", []),
        ("g6-036", "calibration", "summary", "Run `npm run build:admin` before packaging the local release.", []),
        ("g6-037", "calibration", "background", "The callback remains at https://example.invalid/auth/callback during testing.", []),
        ("g6-038", "calibration", "solution", "Contact benchmark@example.invalid only in the synthetic fixture.", []),
        ("g6-039", "calibration", "background", "The database identifier `assistive_validation_jobs` is not prose.", []),
        ("g6-040", "calibration", "solution", "The file report.final.json is generated in a temporary directory.", []),
        ("g6-061", "holdout", "summary", "Grafana displays aggregate latency without exposing source text.", ["Grafana"]),
        ("g6-062", "holdout", "solution", "Prometheus collects counters from the isolated worker.", ["Prometheus"]),
        ("g6-063", "holdout", "background", "Elasticsearch was considered unnecessary for the bounded candidate pool.", ["Elasticsearch"]),
        ("g6-064", "holdout", "summary", "The OpenAPI document describes the local request contract.", ["OpenAPI"]),
        ("g6-065", "holdout", "solution", "NumPy calculates deterministic vectors for the synthetic fixture.", ["NumPy"]),
        ("g6-066", "holdout", "background", "SciPy is not required by the lexical baseline.", ["SciPy"]),
        ("g6-067", "holdout", "solution", "PyTorch would add operational cost to an embedding challenger.", ["PyTorch"]),
        ("g6-068", "holdout", "summary", "Terraform is outside the scope of this local benchmark.", ["Terraform"]),
        ("g6-069", "holdout", "background", "Ansible playbooks are not executed by corpus text.", ["Ansible"]),
        ("g6-070", "holdout", "solution", "OAuth uses PKCE to bind the authorisation request.", ["OAuth", "PKCE"]),
        ("g6-071", "holdout", "title", "OCR Review Workflow", ["OCR"]),
        ("g6-072", "holdout", "title", "API Security Controls", ["API"]),
        ("g6-073", "holdout", "summary", "The organisation standardises licence metadata for each dependency.", []),
        ("g6-074", "holdout", "background", "The metre reading was normalised before analysis.", []),
        ("g6-075", "holdout", "solution", "The request was rejected because its payload exceeded the documented bound.", []),
        ("g6-076", "holdout", "summary", "Use `git diff --check` to inspect whitespace safely.", []),
        ("g6-077", "holdout", "background", "The trace ID 123e4567-e89b-12d3-a456-426614174000 is synthetic.", []),
        ("g6-078", "holdout", "solution", "The command `python -m unittest` is shown as inert text.", []),
        ("g6-079", "holdout", "background", "The filename phase6.report.json is excluded from prose checking.", []),
        ("g6-080", "holdout", "solution", "The passive sensor was installed beside the existing pump.", []),
    ]
    clean = [_clean_case(*spec) for spec in clean_specs]
    return sorted(errors + clean, key=lambda case: case["id"])


TOPICS = [
    ("Flood Culvert Alert", "blocked stormwater culverts", "detect rising water and notify maintenance crews", "LoRaWAN"),
    ("Bridge Bearing Monitor", "wear in bridge bearings", "measure vibration and prioritise structural inspections", "MQTT"),
    ("Cold Room Energy Coach", "energy waste in refrigerated rooms", "forecast demand and recommend compressor schedules", "PostgreSQL"),
    ("Accessible Campus Wayfinder", "navigation barriers across a large campus", "provide step-free routes with live obstruction notices", "OpenStreetMap"),
    ("Orchard Irrigation Planner", "uneven soil moisture in orchards", "combine probe readings with weather forecasts for watering plans", "Modbus"),
    ("Workshop Air Sentinel", "unsafe particulate levels in workshops", "monitor air quality and trigger local ventilation alerts", "Grafana"),
    ("Food Rescue Matcher", "surplus food being discarded", "match donors with nearby community collection windows", "FastAPI"),
    ("Coastal Erosion Mapper", "slow changes to vulnerable shorelines", "compare repeat imagery and map erosion trends", "PostGIS"),
    ("Library Noise Guide", "learners struggling to find quiet study areas", "publish privacy-preserving acoustic zone summaries", "WebSockets"),
    ("Battery Reuse Assessor", "uncertain health of retired battery modules", "run bounded discharge tests and estimate reuse suitability", "CAN bus"),
    ("Bushfire Hydrant Auditor", "outdated records for rural hydrants", "capture inspections offline and reconcile maintenance priorities", "SQLite"),
    ("Solar Inverter Triage", "delayed diagnosis of rooftop inverter faults", "rank likely faults from local telemetry and service history", "OpenTelemetry"),
    ("Aged Care Meal Monitor", "missed meal delivery checks", "record trolley handovers without tracking residents", "NFC"),
    ("Wetland Bird Counter", "manual counting of birds in wetland surveys", "assist observers with image-based count summaries", "PyTorch"),
    ("Textile Repair Exchange", "repairable clothing entering landfill", "connect repair skills with local garment requests", "Next.js"),
    ("Rail Crossing Queue Study", "traffic queues near suburban rail crossings", "aggregate anonymous travel times for planning", "Bluetooth"),
    ("Greenhouse Disease Log", "late recognition of crop disease patterns", "combine staff observations with environmental histories", "TimescaleDB"),
    ("Community Battery Scheduler", "peak demand stressing a shared battery", "simulate fair charge and discharge schedules", "NumPy"),
    ("Construction Dust Diary", "incomplete dust-control evidence on worksites", "capture bounded readings with supervisor annotations", "Prometheus"),
    ("Museum Climate Watch", "humidity changes threatening stored artefacts", "track room conditions and escalate sustained excursions", "Zigbee"),
]


def _project(candidate_id: str, title: str, summary: str, background: str, solution: str) -> dict[str, str]:
    return {"id": candidate_id, "title": title, "summary": summary, "background": background, "solution": solution}


def _duplicate_data(seed: int) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
    candidates: list[dict[str, str]] = []
    for index, (title, problem, action, stack) in enumerate(TOPICS, start=1):
        prefix = f"p6-{index:03d}"
        candidates.extend([
            _project(f"{prefix}-target", title,
                     f"This project addresses {problem}.",
                     f"Current teams have limited evidence about {problem} until a manual review occurs.",
                     f"The prototype will {action} using a local {stack} workflow."),
            _project(f"{prefix}-domain", f"{title} Policy Review",
                     f"This study documents policy options related to {problem}.",
                     f"The same domain requires clearer governance, but no monitoring product is proposed.",
                     "The outcome is a staff-authored policy guide rather than the target system."),
            _project(f"{prefix}-stack", f"{stack} Training Dashboard",
                     f"A teaching dashboard demonstrates {stack} with synthetic counters.",
                     "Learners need a safe environment for learning the selected technology.",
                     "The prototype presents tutorials and does not address the target project problem."),
            _project(f"{prefix}-title", f"{title} Archive",
                     "The archive catalogues historical reports for browsing.",
                     "Existing files are difficult to search, but no live sensing or decision support is needed.",
                     "A metadata index replaces the operational solution implied by the similar title."),
            _project(f"{prefix}-boilerplate", f"Sustainable {title}",
                     "This capstone project delivers an innovative, user-centred and sustainable solution.",
                     f"Stakeholders mentioned {problem}, alongside several unrelated opportunities.",
                     "The team will follow an agile process and produce a generic demonstration."),
            _project(f"{prefix}-other", f"{stack} Equipment Booking",
                     "The project manages bookings for shared laboratory equipment.",
                     "Double bookings reduce teaching time in practical classes.",
                     f"A local {stack} application records reservations and approval windows."),
        ])

    candidate_ids = [candidate["id"] for candidate in candidates]
    queries: list[dict[str, Any]] = []
    for index, (title, problem, action, stack) in enumerate(TOPICS, start=1):
        target_id = f"p6-{index:03d}-target"
        target = next(candidate for candidate in candidates if candidate["id"] == target_id)
        for variant in ("exact", "near"):
            is_calibration = (variant == "exact") == (index % 2 == 1)
            split = "calibration" if is_calibration else "holdout"
            if variant == "exact":
                query_title = target["title"].upper() if index % 4 == 0 else target["title"]
                query_summary = target["summary"]
                query_background = target["background"]
                query_solution = target["solution"]
                relationship = "EXACT_DUPLICATE"
                transformation = "case_punctuation_normalized" if index % 4 == 0 else "same_title_content"
            else:
                words = title.split()
                query_title = f"{''.join(word[0] for word in words)} — {words[-1]}" if index % 5 == 0 else f"{title}: Field Prototype"
                query_summary = f"The team targets {problem} with an operational prototype."
                query_background = f"Manual review currently happens before teams obtain reliable evidence about {problem}."
                query_solution = f"Using {stack} locally, the system will {action}."
                relationship = "NEAR_DUPLICATE"
                transformation = ("title_abbreviation" if index % 5 == 0 else
                                  "reordered_sentences" if index % 3 == 0 else "light_paraphrase")
            relations = {candidate_id: "UNRELATED" for candidate_id in candidate_ids}
            relations[target_id] = relationship
            for suffix in ("domain", "stack", "title", "boilerplate", "other"):
                relations[f"p6-{index:03d}-{suffix}"] = "RELATED_NOT_DUPLICATE"
            queries.append({
                "id": f"dq6-{index:03d}-{variant}",
                "split": split,
                "transformation": transformation,
                "title": query_title,
                "summary": query_summary,
                "background": query_background,
                "solution": query_solution,
                "relationships": relations,
            })

    random.Random(seed).shuffle(candidates)
    return candidates, sorted(queries, key=lambda query: query["id"])


def build_phase6_manifest(seed: int = PHASE6_SEED) -> dict[str, Any]:
    candidates, queries = _duplicate_data(seed)
    return {
        "schema_version": PHASE6_SCHEMA_VERSION,
        "corpus_version": PHASE6_CORPUS_VERSION,
        "seed": seed,
        "provenance": "Deterministic synthetic technical prose; no participant or production project data.",
        "grammar_cases": _grammar_cases(),
        "duplicate_candidates": candidates,
        "duplicate_queries": queries,
    }


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def manifest_sha256(value: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def validate_phase6_manifest(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict) or data.get("schema_version") != PHASE6_SCHEMA_VERSION:
        raise ValueError("Phase 6 manifest schema_version must be 1")
    if data.get("corpus_version") != PHASE6_CORPUS_VERSION or data.get("seed") != PHASE6_SEED:
        raise ValueError("Phase 6 corpus version and seed are frozen")
    grammar = data.get("grammar_cases")
    candidates = data.get("duplicate_candidates")
    queries = data.get("duplicate_queries")
    if not isinstance(grammar, list) or len(grammar) != 80:
        raise ValueError("Phase 6 grammar corpus must contain exactly 80 frozen cases")
    if not isinstance(candidates, list) or len(candidates) < 100:
        raise ValueError("Phase 6 duplicate pool must contain at least 100 projects")
    if not isinstance(queries, list) or not 30 <= len(queries) <= 50:
        raise ValueError("Phase 6 duplicate corpus must contain 30..50 queries")

    grammar_ids: set[str] = set()
    for case in grammar:
        case_id = case.get("id")
        text = case.get("source_text")
        if not isinstance(case_id, str) or case_id in grammar_ids or not case_id.replace("-", "").isalnum():
            raise ValueError("Phase 6 grammar case IDs must be unique and bounded")
        grammar_ids.add(case_id)
        if case.get("split") not in SPLITS or case.get("field") not in FIELDS or not isinstance(text, str) or not text:
            raise ValueError(f"{case_id} has an invalid split, field, or source text")
        issues = case.get("issues")
        if not isinstance(issues, list) or bool(issues) == bool(case.get("intentionally_clean")):
            raise ValueError(f"{case_id} clean/error declaration is inconsistent")
        for issue in issues:
            start, end = issue.get("start"), issue.get("end")
            if not isinstance(start, int) or not isinstance(end, int) or not 0 <= start < end <= len(text):
                raise ValueError(f"{case_id} issue span is invalid")
            if text[start:end] != issue.get("source"):
                raise ValueError(f"{case_id} issue source does not match its span")
            corrections = issue.get("accepted_corrections")
            if not isinstance(corrections, list) or not corrections or not all(isinstance(value, str) and value for value in corrections):
                raise ValueError(f"{case_id} requires accepted corrections")

    candidate_ids = [candidate.get("id") for candidate in candidates]
    if len(candidate_ids) != len(set(candidate_ids)) or not all(isinstance(value, str) for value in candidate_ids):
        raise ValueError("Phase 6 duplicate candidate IDs must be unique strings")
    required_project_fields = {"id", "title", "summary", "background", "solution"}
    for candidate in candidates:
        if set(candidate) != required_project_fields or not all(isinstance(candidate[field], str) and candidate[field] for field in required_project_fields):
            raise ValueError("Duplicate candidates must use only the supported project prose fields")
    candidate_id_set = set(candidate_ids)
    for query in queries:
        if query.get("split") not in SPLITS:
            raise ValueError("Duplicate query split is invalid")
        if not all(isinstance(query.get(field), str) and query[field] for field in ("id", "title", "summary", "background", "solution")):
            raise ValueError("Duplicate query prose fields must be non-empty strings")
        relationships = query.get("relationships")
        if not isinstance(relationships, dict) or set(relationships) != candidate_id_set:
            raise ValueError(f"{query.get('id')} must label every candidate")
        if any(value not in RELATIONSHIPS for value in relationships.values()):
            raise ValueError(f"{query.get('id')} contains an unsupported relationship")
        counts = Counter(relationships.values())
        if counts["EXACT_DUPLICATE"] + counts["NEAR_DUPLICATE"] != 1 or counts["RELATED_NOT_DUPLICATE"] < 4:
            raise ValueError(f"{query.get('id')} needs one duplicate and meaningful hard negatives")

    for split in SPLITS:
        grammar_split = [case for case in grammar if case["split"] == split]
        query_split = [query for query in queries if query["split"] == split]
        if len(grammar_split) != 40 or sum(case["intentionally_clean"] for case in grammar_split) != 20:
            raise ValueError(f"{split} grammar split must contain 20 clean and 20 erroneous cases")
        if len(query_split) != 20:
            raise ValueError(f"{split} duplicate split must contain 20 queries")
        relation_types = {
            next(value for value in query["relationships"].values()
                 if value in {"EXACT_DUPLICATE", "NEAR_DUPLICATE"})
            for query in query_split
        }
        if relation_types != {"EXACT_DUPLICATE", "NEAR_DUPLICATE"}:
            raise ValueError(f"{split} must contain exact and near duplicate queries")
    return data


def load_phase6_manifest(path: Path) -> dict[str, Any]:
    return validate_phase6_manifest(json.loads(path.read_text(encoding="utf-8")))
