# Resource Ownership and Transfer Matrix

**STATUS:** Current — handover
**PURPOSE:** Operations
**LAST VERIFIED:** 2026-08-28

Every external resource the platform depends on, who owns it **today**, who must own it **finally**,
and exactly how to get from one to the other.

This is the *resource* view. The *role* view — who is responsible for which duty, with a named
primary and backup — lives in
[Operational Ownership, Handover, and Training](../operational-handover-and-training.md). Both are
required; neither replaces the other.

Related: [Environment Matrix](environment-matrix.md) ·
[Free-Tier Capacity](../operations/free-tier-capacity-and-handover.md) ·
[Handover entry point](README.md)

---

## 1. Ownership classes

| Class | Meaning |
| :--- | :--- |
| **A — School-owned** | Already controlled by RMIT or SSET |
| **B — Transferable** | Exists today and can be formally transferred to an institutional account |
| **C — Redeployable** | Can be recreated from source and infrastructure-as-code in a School account. Nothing unique is lost |
| **D — Temporary development only** | Currently under an individual team member's personal account. Must not survive as a handover dependency |

**A resource under an individual team member's personal account is not "School-owned" until the
transfer has actually happened.** Nothing in this document may be marked otherwise before the
evidence exists.

---

## 2. Matrix

Fill `Account / project identifier`, `Current status`, and `Handover evidence` during the real
transfer. They are left blank here because inventing them would be a false record.

### Source control and build

| Field | GitHub repository | GitHub Packages / container registry |
| :--- | :--- | :--- |
| Purpose | Source of truth, CI, releases | Executor images for Profile A |
| Current class | D — team-owned organisation | Not in use; nothing published |
| Required final class | B — transfer, or C — fork into a School organisation | C — created in the School organisation, if Profile A is adopted |
| Account / identifier | | |
| Transferable | Yes — organisation or repository transfer | N/A |
| Redeployable | Yes — the repository is self-contained | Yes — rebuild from the Dockerfiles |
| Procedure | Transfer to the School organisation, or fork and re-point CI. Reconfigure branch protection and `CODEOWNERS` | Enable the manual image workflow in the School organisation. **First** complete [the licence review](third-party-licences.md) |
| Secret owner | Repository administrator | Repository administrator |
| Backup owner | Git history is distributed; every clone is a copy | Images are rebuildable from source |
| Recovery owner | Technical maintainer | Technical maintainer |
| Status / evidence | | |

### Data

| Field | Supabase organisation | Supabase project (database, auth, storage) |
| :--- | :--- | :--- |
| Purpose | Billing and access boundary | Authoritative project data, staff identity, private and public media |
| Current class | D — team-owned | D — team-owned staging project |
| Required final class | B — transfer, or C — recreate under a School organisation | B, or C — recreate and restore |
| Account / identifier | | |
| Transferable | Yes — organisation ownership transfer | Yes, with the organisation |
| Redeployable | Yes | Yes — 47 migrations plus a restored backup reproduce it exactly |
| Procedure | Transfer to a School-controlled organisation, or create a School organisation and move the project | Transfer with the organisation; or create a project, apply migrations, restore database and storage, re-provision staff, rotate keys |
| Secret owner | Database / infrastructure maintainer | Database / infrastructure maintainer |
| Backup owner | N/A | **Operator-driven. Free plans include no automatic backups** |
| Recovery owner | Database / infrastructure maintainer | Database / infrastructure maintainer |
| Status / evidence | | |

### Application hosting

| Field | Render workspace and Admin/CMS service | Cloud subscription (Profile A only) | School compute host (Profile B only) |
| :--- | :--- | :--- | :--- |
| Purpose | Serves the Admin/CMS | Runs the dispatcher and heavy worker jobs | Runs the continuous worker |
| Current class | D — team-owned | Not provisioned | Not provisioned |
| Required final class | B or C | A — a dedicated School-controlled subscription | A |
| Account / identifier | | | |
| Transferable | Yes — workspace transfer or invite | Not applicable — created by the School | Not applicable |
| Redeployable | Yes — the service is defined by build command, start command, and environment variables | Yes — one infrastructure-as-code deployment | Yes — one `docker build` and `docker run` |
| Procedure | Transfer the workspace, or create a School service and re-enter environment variables | Deploy [the executor template](../../infra/azure/assistive-executor/README.md), create the dispatcher database role, register the executor | Follow the Profile B section of [the executor guide](../operations/zero-cost-assistive-executor.md) |
| Secret owner | Technical maintainer | Technical maintainer with the subscription owner | Technical maintainer |
| Backup owner | Stateless — rebuilt from source | Stateless — rebuilt from the template | Stateless |
| Recovery owner | Technical maintainer | Technical maintainer | Technical maintainer |
| Status / evidence | | | |

**Choose one execution profile.** Profile A needs a School-controlled subscription and a public
image; Profile B needs a School Docker host and nothing else. A dedicated subscription matters: the
compute grant is per subscription, so a shared one means the PP1 ceiling alone cannot guarantee a
zero bill.

### Public layer and communications

| Field | Duda site and account | DNS / custom domain | Email delivery |
| :--- | :--- | :--- | :--- |
| Purpose | Public showcase consuming the published feed | Public addresses, if used | Participant preview notifications and reminders |
| Current class | A or D — confirm with the School | A or D — confirm with the School | Not configured; disabled by default |
| Required final class | A | A | A — an institutional mail arrangement |
| Account / identifier | | | |
| Transferable | Yes — account or site ownership transfer | Yes — registrar and zone control | Yes |
| Redeployable | No — the site itself is not reproduced from this repository | Yes | Yes |
| Procedure | Confirm the owner, transfer administration, re-point the feed consumer | Confirm registrar and zone authority | Configure an approved institutional sender, then enable the feature flag |
| Secret owner | Duda maintainer | DNS owner | Technical maintainer |
| Backup owner | Feed version history is retained in the database | Registrar | Provider |
| Recovery owner | Duda maintainer | DNS owner | Technical maintainer |
| Status / evidence | | | |

### Operational secrets

Names and ownership only. **No value belongs in this repository.**

| Secret name | Consumer | Privilege | Where stored | How to create | How to rotate | Recovery |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `SUPABASE_SECRET_KEY` | Admin/CMS, assistive worker | Full server-side database and storage access | Hosting platform secret store | Supabase project API settings | Issue a new secret key, update every consumer, redeploy, revoke the old key | Reissue from the project; requires project administration |
| `CAPSTONE_ASSISTIVE_DISPATCHER_DB_URL` | Dispatcher job only | **Least privilege.** Execute four execution-control routines; no table access, no project data, no workflow or publication routine | Cloud job secret | Set the Migration 0047 role password interactively with `\password capstone_assistive_dispatcher` | Set a new password, update the job secret, confirm the next dispatch succeeds | Re-run `\password`; requires database administration |
| `CAPSTONE_EXPECTED_SUPABASE_HOST` | Admin/CMS, worker, dispatcher | Configuration, not a credential | Hosting platform configuration | The project's canonical hostname | Change only when the project changes | From the project settings |
| Cloud managed identity | Dispatcher job | Read one job and start one execution. **No secret exists to leak** | Platform-managed | Created by the executor template | Not applicable — no stored credential | Redeploy the template |
| Participant email credentials | Admin/CMS, when enabled | Send only | Hosting platform secret store | Institutional mail provider | Provider procedure | Provider procedure |

The dispatcher deliberately holds **no** server secret key, and the worker deliberately holds **no**
cloud management permission. Neither can do the other's job.

---

## 3. Dependencies that must not survive handover

Nothing in the final system may permanently depend on:

an individual team member's laptop, personal accounts of any kind, a personal payment method, a file
that exists only on one machine, undocumented knowledge, or any AI assistant's conversation history.

Every operational procedure the School needs is in this repository. If something is missing, that is
a defect to fix here, not knowledge to keep in someone's head.

Temporary team-owned resources may exist during development. They are class **D** and must be
transferred or recreated before handover completes.

---

## 4. Transfer sequence

1. Confirm the institutional accounts and aliases that will own each resource.
2. Transfer or fork the repository; reconfigure branch protection and code owners.
3. Transfer or recreate the Supabase organisation and project; apply all 47 migrations; restore data
   if recreating; re-provision staff accounts.
4. Rotate every credential into School-controlled storage and revoke the previous values.
5. Transfer or recreate the Admin/CMS hosting service.
6. Choose an execution profile and provision it in School infrastructure.
7. Confirm Duda, DNS, and email ownership.
8. Perform a restore rehearsal against a disposable database and record the result.
9. Complete the release acceptance checklist and the training instrument.
10. Record every identifier, status, and evidence reference in this matrix.

Handover is complete only when steps 1 to 10 carry real evidence.
