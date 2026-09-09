# Supply-Chain Security Gates

**STATUS:** Implemented repository controls; repository-setting enablement remains owner-operated

## Scope and threat boundary

These controls cover dependency changes, managed update proposals, static analysis, committed
secret patterns, lockfile integrity, and GitHub Actions references using only public-repository
GitHub features and repository-owned scripts. They send no source or credentials to a third-party
scanner.

Pull-request code is untrusted. Workflows triggered by `pull_request` declare only
`contents: read`, do not reference repository secrets, and check out with
`persist-credentials: false`. The repository's current GitHub security configuration does not
support Dependency Review, so no required job claims to perform it. A separately named root npm
production advisory audit provides the blocking advisory check. CodeQL needs
`security-events: write` to upload results, so
its workflow intentionally runs only after a commit reaches `main`, on a weekly schedule, or by a
trusted manual dispatch. It uses `build-mode: none`; untrusted code is not built with a
write-capable token.

## Implemented controls

### Dependency changes and updates

- `.github/workflows/security.yml` runs the deterministic repository-owned dependency integrity
  check on every push and pull request. It fails closed on manifest/lockfile drift, non-registry
  package sources, missing integrity metadata, or workflow-policy regression.
- The separately named `Root npm Production Advisory Audit` runs `npm audit --package-lock-only
  --omit=dev --audit-level=high`. It covers current production dependencies represented by the root
  npm lockfile; it is not a dependency-delta review and does not cover Python advisories. Its result
  depends on the npm registry's current advisory data and availability.
- `.github/dependabot.yml` proposes grouped npm, Python, and GitHub Actions updates. Active root and
  assistive-worker dependencies are checked weekly. Historical Prototype and benchmark tooling are
  checked monthly to limit proposal noise. Per-ecosystem open-pull-request limits bound the queue.
- `tools/security/security-policy.mjs` requires npm lockfile version 3, manifest/lock root
  agreement, npm-registry resolution, and integrity metadata for external npm packages. Workspace
  links are the only non-registry lock entries allowed.

The current root lockfile already contains the production dependency remediation for Next.js,
Nodemailer, PostCSS, and their affected transitive packages. The deterministic integrity policy
does not claim zero advisories; the separate live audit gate owns that mutable, network-dependent
decision and may change as registry advisories are published or reclassified.

### Static analysis

`.github/workflows/codeql.yml` analyzes JavaScript/TypeScript and Python on each trusted `main`
push and weekly. Repository owners must keep GitHub Actions, the dependency graph, Dependabot,
and code scanning enabled; no automation here changes repository settings.

### Secret patterns

`tools/security/secret-scan.mjs` scans Git-indexed and non-ignored working-tree files without a
package install. It detects high-signal private-key, provider-token, live payment-key, and JWT
formats plus a narrower generic credential-assignment heuristic. Binary files are skipped.

Allowlisting is rule-scoped in `tools/security/secret-scan.config.json`. Synthetic test files and
machine evidence paths bypass only the generic assignment heuristic; provider-specific tokens and
private keys still fail in those paths. Explicit placeholder forms are value-allowlisted. A failure
prints only the rule identifier, repository path, and line number—never the matched value. The gate
does not scan Git history and is not a replacement for GitHub secret scanning or push protection;
owners should keep those free public-repository features enabled.

### Action integrity and workflow policy

Every remote action in `.github/workflows` is pinned to a full 40-character commit SHA with its
human-readable release in a comment. Dependabot's monthly GitHub Actions update group preserves
updatability. The local policy check rejects mutable action references, missing release comments,
`pull_request_target`, pull-request write permissions, pull-request secret references, persisted
checkout credentials, and pull-request-triggered CodeQL upload authority. The existing YAML parser
now covers every workflow plus Dependabot configuration. Under this task's no-network boundary,
local validation proves pin shape and coverage but does not re-resolve upstream tags; GitHub fails
closed if a pinned commit cannot be fetched when the workflow runs.

## Intentionally deferred

- **SBOM publication:** npm lockfiles, Python lockfiles, and GitHub's dependency graph provide the
  current inventory. No release artifact publication/signing workflow exists, so committing a
  timestamped SBOM or generating an unauthenticated CI artifact would add churn without a defined
  consumer. Add a GitHub-native attested SBOM when the release process owns retention and review.
- **Container vulnerability scanning:** the executor builds are manual and the heavy image downloads
  large, hash-verified model artifacts. No reliable first-party GitHub container vulnerability gate
  is configured, and adding a marketplace scanner would violate the no-third-party/no-fragile-tool
  boundary. Image/base-image scanning and digest refresh remain release-operations work.
- **Base-image digest pins:** both Dockerfiles name exact Node patch tags but not immutable image
  digests. Resolving and verifying multi-platform digests requires current registry metadata, which
  was outside this offline task. Do not guess a digest.
- **Historical secret scanning:** the local scanner covers the checked-out tree only. GitHub's
  public-repository secret scanning is the appropriate free history monitor and must be confirmed
  in repository settings by an owner.

## Local verification

```text
node --test tools/security/*.test.mjs
npm run check:secrets
npm run check:security-ci
npm run check:yaml
npm run check:zero-cost
npm run check:terminology
git diff --check
```

Expected incremental CI load is one short zero-dependency policy job, one root npm production
advisory job per push/pull request, and two CodeQL language jobs per trusted `main` push plus one
weekly run. These checks require no new paid service. Dependabot remains asynchronous repository
configuration for update proposals; no blocking dependency-delta review is claimed.
