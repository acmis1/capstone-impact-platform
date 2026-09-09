#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VALIDATOR="${VALIDATOR:-$SCRIPT_DIR/validate-oci-image-digest.sh}"
WORKFLOW="${WORKFLOW:-$REPO_ROOT/.github/workflows/assistive-worker-image.yml}"
SELF="$SCRIPT_DIR/test-assistive-image-digest.sh"
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

assert_contains() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  [[ "$actual" == *"$expected"* ]] || fail "$label (missing: $expected)"
}

assert_not_contains() {
  local actual="$1"
  local forbidden="$2"
  local label="$3"
  [[ "$actual" != *"$forbidden"* ]] || fail "$label (unexpected: $forbidden)"
}

assert_digest() {
  local label="$1"
  local archive="$2"
  local expected="$3"
  local actual
  actual="$(bash "$VALIDATOR" "$label" "$archive")" || fail "$label valid fixture unexpectedly failed"
  [[ "$actual" == "$expected" ]] || fail "$label reported $actual; expected $expected"
  pass "$label reports exact digest $expected"
}

assert_rejects() {
  local label="$1"
  local archive="$2"
  local output="$TEST_TMP/${label//[^A-Za-z0-9_-]/_}.log"
  if bash "$VALIDATOR" "$label" "$archive" > "$output" 2>&1; then
    fail "$label invalid fixture unexpectedly passed"
  fi
  pass "$label rejected"
}

MANIFEST='{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":0},"layers":[]}'
MANIFEST_HASH="$(printf '%s' "$MANIFEST" | sha256sum | awk '{print $1}')"
MANIFEST_DIGEST="sha256:$MANIFEST_HASH"
MANIFEST_SIZE="$(printf '%s' "$MANIFEST" | wc -c | tr -d '[:space:]')"

descriptor() {
  local digest="$1"
  local os="$2"
  local architecture="$3"
  printf '{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"%s","size":%s,"platform":{"architecture":"%s","os":"%s"}}' \
    "$digest" "$MANIFEST_SIZE" "$architecture" "$os"
}

build_archive() {
  local name="$1"
  local index_json="$2"
  local blob_mode="$3"
  local layout="$TEST_TMP/layout-$name"
  local archive="$TEST_TMP/$name.oci.tar"
  local blob_path="blobs/sha256/$MANIFEST_HASH"

  mkdir -p "$layout/blobs/sha256"
  printf '%s' "$index_json" > "$layout/index.json"
  case "$blob_mode" in
    valid) printf '%s' "$MANIFEST" > "$layout/$blob_path" ;;
    mismatch) printf '%s' '{"not":"the manifest"}' > "$layout/$blob_path" ;;
    missing) ;;
    *) fail "unknown fixture blob mode: $blob_mode" ;;
  esac

  if [[ "$blob_mode" == "missing" ]]; then
    tar -cf "$archive" -C "$layout" index.json
  else
    tar -cf "$archive" -C "$layout" index.json "$blob_path"
  fi
  printf '%s' "$archive"
}

run_fixture_tests() {
  local valid_descriptor wrong_platform_descriptor malformed_descriptor valid_index
  valid_descriptor="$(descriptor "$MANIFEST_DIGEST" linux amd64)"
  wrong_platform_descriptor="$(descriptor "$MANIFEST_DIGEST" linux arm64)"
  malformed_descriptor="$(descriptor sha256:not-a-digest linux amd64)"
  valid_index="$(printf '{"schemaVersion":2,"manifests":[%s]}' "$valid_descriptor")"

  local valid_archive wrong_platform_archive multiple_archive malformed_archive missing_blob_archive mismatch_archive
  valid_archive="$(build_archive valid "$valid_index" valid)"
  wrong_platform_archive="$(build_archive wrong-platform "$(printf '{"schemaVersion":2,"manifests":[%s]}' "$wrong_platform_descriptor")" valid)"
  multiple_archive="$(build_archive multiple "$(printf '{"schemaVersion":2,"manifests":[%s,%s]}' "$valid_descriptor" "$valid_descriptor")" valid)"
  malformed_archive="$(build_archive malformed "$(printf '{"schemaVersion":2,"manifests":[%s]}' "$malformed_descriptor")" valid)"
  missing_blob_archive="$(build_archive missing-blob "$valid_index" missing)"
  mismatch_archive="$(build_archive blob-mismatch "$valid_index" mismatch)"

  assert_digest valid "$valid_archive" "$MANIFEST_DIGEST"
  assert_rejects wrong-platform "$wrong_platform_archive"
  assert_rejects multiple-descriptors "$multiple_archive"
  assert_rejects malformed-digest "$malformed_archive"
  assert_rejects missing-manifest-blob "$missing_blob_archive"
  assert_rejects blob-hash-mismatch "$mismatch_archive"

  : > "$TEST_TMP/empty.oci.tar"
  assert_rejects empty-archive "$TEST_TMP/empty.oci.tar"
  assert_rejects missing-archive "$TEST_TMP/does-not-exist.oci.tar"
}

build_job() {
  awk '
    $0 == "  build-only:" { in_job = 1 }
    in_job && $0 == "  publish:" { exit }
    in_job { print }
  ' "$WORKFLOW"
}

publish_job() {
  awk '
    $0 == "  publish:" { in_job = 1 }
    in_job { print }
  ' "$WORKFLOW"
}

step_from_build_job() {
  local target="$1"
  build_job | awk -v target="$target" '
    $0 == target { in_step = 1; print; next }
    in_step && $0 ~ /^      - name: / { exit }
    in_step { print }
  '
}

run_static_tests() {
  local workflow_text on_block build build_worker build_dispatcher validator publish
  workflow_text="$(< "$WORKFLOW")"
  on_block="$(awk '
    $0 == "on:" { in_on = 1; print; next }
    in_on && $0 ~ /^[^[:space:]#]/ { exit }
    in_on { print }
  ' "$WORKFLOW")"
  build="$(build_job)"
  build_worker="$(step_from_build_job '      - name: Build heavy assistive worker image')"
  build_dispatcher="$(step_from_build_job '      - name: Build scheduled dispatcher image')"
  validator="$(step_from_build_job '      - name: Validate and report local OCI image manifest digests')"
  publish="$(publish_job)"

  [[ "$(printf '%s\n' "$on_block" | awk '/^  [A-Za-z0-9_-]+:$/ { print $1 }')" == "workflow_dispatch:" ]] \
    || fail "workflow trigger block is not workflow_dispatch-only"
  if printf '%s\n' "$on_block" | grep -Eq '^  (push|pull_request|schedule):'; then
    fail "workflow trigger block contains a non-manual event"
  fi
  assert_contains "$build" 'if: ${{ !inputs.publish }}' 'build-only publish gate'
  assert_contains "$build_worker" 'platforms: linux/amd64' 'worker platform'
  assert_contains "$build_dispatcher" 'platforms: linux/amd64' 'dispatcher platform'
  assert_contains "$build_worker" 'outputs: type=oci,dest=/tmp/capstone-assistive-worker.oci.tar' 'worker OCI output'
  assert_contains "$build_dispatcher" 'outputs: type=oci,dest=/tmp/capstone-assistive-dispatcher.oci.tar' 'dispatcher OCI output'
  assert_not_contains "$build_worker" 'outputs: type=oci,dest=/tmp/capstone-assistive-dispatcher.oci.tar' 'worker output distinctness'
  assert_not_contains "$build_dispatcher" 'outputs: type=oci,dest=/tmp/capstone-assistive-worker.oci.tar' 'dispatcher output distinctness'
  assert_contains "$validator" 'worker_digest="$(bash tools/assistive-image-digest/validate-oci-image-digest.sh worker /tmp/capstone-assistive-worker.oci.tar)"' 'worker validator call'
  assert_contains "$validator" 'dispatcher_digest="$(bash tools/assistive-image-digest/validate-oci-image-digest.sh dispatcher /tmp/capstone-assistive-dispatcher.oci.tar)"' 'dispatcher validator call'
  assert_contains "$build" 'push: false' 'build-only push setting'
  assert_not_contains "$build" 'push: true' 'build-only push isolation'
  assert_not_contains "$build" 'docker/login-action' 'build-only registry login isolation'
  assert_not_contains "$build" 'packages: write' 'build-only package permission isolation'
  assert_contains "$publish" 'if: ${{ inputs.publish }}' 'publish gate'
  assert_contains "$publish" 'docker/login-action@9780b0c442fbb1117ed29e0efdff1e18412f7567 # v3.3.0' 'publish registry login'
  assert_contains "$publish" 'packages: write' 'publish package permission'
  assert_contains "$publish" 'push: true' 'publish push setting'
  assert_not_contains "$publish" 'validate-oci-image-digest.sh' 'publish path unchanged'
  pass 'workflow static contract'
}

expect_static_rejection() {
  local label="$1"
  local mutated_workflow="$2"
  if WORKFLOW="$mutated_workflow" bash "$SELF" --static-only > "$TEST_TMP/$label.log" 2>&1; then
    fail "mutation survived static tests: $label"
  fi
  pass "mutation rejected: $label"
}

expect_fixture_rejection() {
  local label="$1"
  local mutated_validator="$2"
  if VALIDATOR="$mutated_validator" bash "$SELF" --fixtures-only > "$TEST_TMP/$label.log" 2>&1; then
    fail "mutation survived fixture tests: $label"
  fi
  pass "mutation rejected: $label"
}

run_mutation_tests() {
  local mutated_validator mutated_workflow

  mutated_validator="$TEST_TMP/mutated-validator.sh"
  sed 's/if \[\[ "$actual_digest" != "$digest_hex" \]\]/if [[ "$actual_digest" == "$digest_hex" ]]/' "$VALIDATOR" > "$mutated_validator"
  grep -Fq 'if [[ "$actual_digest" == "$digest_hex" ]]' "$mutated_validator" \
    || fail 'could not create inverted manifest-hash mutation'
  expect_fixture_rejection 'inverted-manifest-hash-comparison' "$mutated_validator"

  mutated_workflow="$TEST_TMP/worker-hard-coded-workflow.yml"
  sed 's|worker_digest="$(bash tools/assistive-image-digest/validate-oci-image-digest.sh worker /tmp/capstone-assistive-worker.oci.tar)"|worker_digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"|' "$WORKFLOW" > "$mutated_workflow"
  expect_static_rejection 'worker-hard-coded-digest' "$mutated_workflow"

  mutated_workflow="$TEST_TMP/dispatcher-arm64-workflow.yml"
  awk '
    $0 == "          file: ./apps/assistive-worker/Dockerfile.dispatcher" { dispatcher = 1 }
    dispatcher && $0 == "          platforms: linux/amd64" { sub("linux/amd64", "linux/arm64"); dispatcher = 0 }
    { print }
  ' "$WORKFLOW" > "$mutated_workflow"
  expect_static_rejection 'dispatcher-arm64-platform' "$mutated_workflow"

  mutated_workflow="$TEST_TMP/indented-push-workflow.yml"
  awk '
    $0 == "  workflow_dispatch:" { print; print "  push:"; next }
    { print }
  ' "$WORKFLOW" > "$mutated_workflow"
  expect_static_rejection 'indented-push-trigger' "$mutated_workflow"
}

case "${1:---all}" in
  --fixtures-only) run_fixture_tests ;;
  --static-only) run_static_tests ;;
  --all)
    run_fixture_tests
    run_static_tests
    run_mutation_tests
    ;;
  *) fail "unknown mode: $1" ;;
esac

echo "Assistive image digest regression tests passed."
