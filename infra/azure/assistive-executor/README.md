# Assistive Executor Infrastructure

**STATUS:** Current — infrastructure as code
**PURPOSE:** Deployment
**LAST VERIFIED:** 2026-08-28

Infrastructure for the zero-cost on-demand assistive executor (Profile A). Nothing here is required
for the School-owned continuous worker (Profile B), which needs no cloud account at all.

Related: [Zero-Cost Assistive Executor](../../../docs/operations/zero-cost-assistive-executor.md) ·
[Free-Tier Capacity](../../../docs/operations/free-tier-capacity-and-handover.md) ·
[Handover entry point](../../../docs/handover/README.md)

---

## 1. What it creates

| Resource | Why |
| :--- | :--- |
| Container Apps managed environment | Consumption-only, log storage disabled, no virtual network |
| User-assigned managed identity | Lets the dispatcher start the worker without any stored secret |
| Custom role definition | Exactly two actions: `Microsoft.App/jobs/read` and `Microsoft.App/jobs/start/action` |
| Role assignment | Scoped to the single worker job, not the resource group |
| Dispatcher job | Schedule trigger, 0.25 vCPU / 0.5 GiB, 15-second timeout, no retry |
| Heavy worker job | Manual trigger, 2.0 vCPU / 4.0 GiB, 600-second timeout, no retry |

## 2. What it deliberately does not create

A Log Analytics workspace, a container registry, virtual-network integration, a NAT gateway, a
static public address, any Dedicated workload profile, or any ingress. Each would create a recurring
charge, widen the blast radius, or both. `npm run check:zero-cost` fails the build if any of them
appears here.

Container Apps jobs do not support ingress at all, so there is no public execution endpoint to
secure — the absence is structural rather than configured.

---

## 3. Prerequisites

- **Owner** or **User Access Administrator** on the target resource group. The custom role
  definition and its assignment require it; nothing else here does.
- The `Microsoft.App` resource provider registered on the subscription.
- Both container images built and their **immutable digests** recorded. The template is pinned to
  digests and never to a tag.
- Migration 0047 applied, and the dispatcher database role given a login password out of band.

Read [the licence review](../../../docs/handover/third-party-licences.md) before publishing any
image publicly.

---

## 4. Parameters

| Parameter | Secure | Description |
| :--- | :--- | :--- |
| `location` | | Region. Defaults to the resource group's |
| `environmentName` | | Managed environment name |
| `dispatcherJobName` | | Scheduled dispatcher job name |
| `workerJobName` | | Heavy worker job name |
| `dispatcherIdentityName` | | User-assigned identity name |
| `dispatcherImageRepository` | | Dispatcher image repository, no tag or digest |
| `dispatcherImageDigest` | | `sha256:…` — immutable |
| `workerImageRepository` | | Worker image repository, no tag or digest |
| `workerImageDigest` | | `sha256:…` — immutable |
| `deploymentVersion` | | The exact 40-character lowercase commit both images were built from |
| `expectedSupabaseHost` | | Canonical hostname of the approved database project |
| `assistiveSupabaseUrl` | | Canonical `https` base URL of the same project |
| `supabaseSecretKey` | ✅ | Server secret key. Reaches only the worker job |
| `dispatcherDatabaseUrl` | ✅ | Least-privilege dispatcher connection URL. Reaches only the dispatcher job |
| `dispatcherCronExpression` | | `*/2 * * * *` (default) or `*/3 * * * *`. Constrained by the template |

The cadence is restricted by an `@allowed` list, so no deployment can select a schedule outside the
reviewed cost envelope. Both secure parameters are supplied at deployment time or from an
institutional secret store; **never commit a parameter file containing real values.**
`main.sample.bicepparam` is a placeholder skeleton, not a working configuration.

---

## 5. Deploy

```bash
# 1. Compile and review
az bicep build --file infra/azure/assistive-executor/main.bicep

# 2. Preview every change before making any
az deployment group what-if \
  --resource-group <rg> \
  --template-file infra/azure/assistive-executor/main.bicep \
  --parameters @<your-local-parameter-file>

# 3. Deploy
az deployment group create \
  --resource-group <rg> \
  --template-file infra/azure/assistive-executor/main.bicep \
  --parameters @<your-local-parameter-file>
```

Then register the executor — nothing can start until the deployed identity is registered — and
enable staff access. Both steps are in
[the executor guide](../../../docs/operations/zero-cost-assistive-executor.md).

Confirm after deployment that the environment reports a Consumption workload profile with log
storage disabled, that the dispatcher is scheduled with the expected cadence and a 15-second
timeout, that the worker is Manual with a 600-second timeout, that both jobs reference the expected
digests, and that the identity holds only the two-action custom role on the worker job.

---

## 6. Verification status

`npm run check:zero-cost` validates this template's structure on every CI run: the workload profile,
the log destination, the absence of every forbidden resource, digest pinning, single-replica
configuration, the constrained cadence, and the exact role actions. It runs without any cloud
toolchain, so it protects the template even on machines that have never seen a cloud CLI.

`az bicep build` and `az deployment group what-if` are operator steps. They require the Azure CLI,
which is not part of this repository's toolchain, so **template compilation and deployment preview
against a real subscription remain pending** and must be completed by the deploying operator before
first use.
