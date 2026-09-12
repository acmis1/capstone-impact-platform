# Environment Matrix

**STATUS:** Current — handover
**PURPOSE:** Operations
**LAST VERIFIED:** 2026-08-28

The environments the platform supports, what each is for, and what each is allowed to do. No secret
value appears here.

Related: [Resource Ownership Matrix](resource-ownership-matrix.md) ·
[Zero-Cost Assistive Executor](../operations/zero-cost-assistive-executor.md) ·
[Handover entry point](README.md)

---

## 1. Environments

| | **Local** | **Disposable test** | **Staging** | **School operational** |
| :--- | :--- | :--- | :--- | :--- |
| **Purpose** | Everyday development | Isolated runtime and migration verification | Shared acceptance and stakeholder demonstration | Real School operation after handover |
| **Database** | Local Supabase via Docker, loopback only | A throwaway stack on its own ports and network, destroyed after each run | Hosted Supabase project | School-controlled Supabase project |
| **Storage** | Local buckets with synthetic fixtures | Throwaway buckets | Hosted buckets, synthetic content | School-controlled buckets |
| **Admin/CMS host** | `127.0.0.1:3000` | Not served | Hosted web service | School-controlled host |
| **Public target** | None | None | No live publication | The School's Duda showcase |
| **Executor** | Loopback worker on the developer machine | Not run | One chosen profile | One chosen profile |
| **Runtime identity** | `CAPSTONE_RUNTIME_ENV` unset or local | Local | Exactly `staging`, with a matching expected host | Candidate code requires exactly `production` with a matching expected host; no operational identity is established yet |
| **Owner** | The developer | CI or the developer | Currently team-owned; must become School-owned | School |
| **Secret source** | Generated locally, git-ignored | Generated per run | Hosting platform secret store | School-controlled secret store |
| **Publication allowed** | Local simulation only | No | Only behind the staging flag, to a staging target | Code defaults disabled; governed publication only after a separately authorized institutional cutover |
| **Backups expected** | None — disposable | None — disposable | Operator-driven | **Operator-driven and scheduled by the School** |
| **Data** | Synthetic only | Synthetic only | **Synthetic only** | Real participant data |

Only the School operational environment may hold real participant data. Everywhere else is synthetic
by rule, and that rule does not relax for convenience.

---

## 2. Isolation rules

- The legacy prototype project and the Admin/CMS project are entirely separate. Neither may target
  the other, ever.
- Hosted operations refuse to run unless the runtime identity and the expected hostname both match
  exactly. A loopback URL is refused for hosted operations, and a hosted URL is refused for local
  ones.
- Publication, staff provisioning, participant email, reminders, and hosted assistive execution are
  all **disabled by default** and each requires an explicit flag *plus* a verified target identity.
  A flag alone is never sufficient.
- The disposable test environment always uses its own project identifier, port block, Docker
  network, and working directory. It never shares the canonical local stack, because some
  verifications are irreversible.

---

## 3. Configuration by environment

Names only.

| Variable | Local | Staging | School operational candidate | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `NEXT_PUBLIC_SUPABASE_URL` | Loopback | Canonical HTTPS project URL | Separately governed canonical HTTPS project URL | Browser-visible; no operational value is stored here |
| `SUPABASE_SECRET_KEY` | Local key | Server secret | Institution-owned server secret | **Never** browser-visible |
| `CAPSTONE_RUNTIME_ENV` | Unset | `staging` | `production` | Gates each named hosted publication target |
| `CAPSTONE_EXPECTED_SUPABASE_HOST` | Unset | Canonical staging hostname | Canonical production hostname | Must exactly equal the selected project URL's host |
| `CAPSTONE_STAGING_PUBLICATION_ENABLED` | Unset | `true` only when deliberately enabled | Unset | Never enables live production publication |
| `CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED` | Unset | Exact `true` only for a supervised rollback window | Unset/`false` | Requires verified staging identity and a separate exact-head database transition; never permits production rollback |
| `CAPSTONE_PRODUCTION_PUBLICATION_ENABLED` | Unset | Unset/`false` | Defaults `false`; exact `true` only in an authorized cutover window | Necessary but insufficient; never enables historical production rollback |
| `CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED` | Unset | `true` only when an executor is ready | Separately qualified value | Necessary but not sufficient |
| `CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION` | Unset | The registered 40-character commit | Separately qualified value | Admin fails closed on drift |
| `CAPSTONE_ASSISTIVE_EXPECTED_WORKER_IMAGE_DIGEST` | Unset | The registered `sha256:` digest | Separately qualified value | Admin fails closed on drift |
| `PARTICIPANT_PREVIEW_EMAIL_ENABLED` | Unset | `true` only with an approved sender | Separately authorized sender only | Manual token generation works regardless |
| `PARTICIPANT_PREVIEW_REMINDERS_ENABLED` | Unset | `true` only when reminders are wanted | Separately authorized schedule only | Reminders are skipped safely when absent |
| `STAFF_PROVISIONING_ENABLED` | Unset | `true` only when provisioning is wanted | Separately authorized window only | Existing invitations still activate |

Worker and dispatcher variables are listed in
[the executor guide](../operations/zero-cost-assistive-executor.md).

---

## 4. Promotion path

```text
Local  ──►  Disposable test  ──►  Staging  ──►  School operational
  │              │                   │                │
  │              │                   │                └─ real data, governed publication
  │              │                   └─ synthetic acceptance, stakeholder demonstration
  │              └─ migrations and runtime behaviour proven in isolation
  └─ feature work, unit tests, local assistive execution
```

A change reaches staging only after the full local gate passes: `npm run verify:all`, the Local
Supabase runtime verifiers, and review. A change reaches School operation only after staging
acceptance and a completed release acceptance checklist.

Database migrations are append-only once merged and are always applied forward. A migration is never
rolled back through the application, and never through the executor.
