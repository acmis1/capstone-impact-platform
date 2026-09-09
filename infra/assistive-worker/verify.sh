#!/bin/sh
set -eu

umask 077
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
compose_file="$script_dir/compose.yaml"
mode=${1:-config}
env_file=${2:-}
acceptance_file=""
acceptance_temp=""
config_output=""
temporary_build_context=""

cleanup() {
  [ -z "$acceptance_temp" ] || rm -f -- "$acceptance_temp"
  [ -z "$config_output" ] || rm -f -- "$config_output"
  [ -z "$temporary_build_context" ] || rm -rf -- "$temporary_build_context"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'Profile B verification failed: %s\n' "$1" >&2
  exit 1
}

canonical_file() {
  [ -f "$1" ] || fail "environment file does not exist"
  command -v realpath >/dev/null 2>&1 || fail "realpath is required"
  realpath -- "$1"
}

assert_path_outside_context() {
  candidate=$(realpath -- "$1")
  context=$(realpath -- "$2")
  case "$candidate" in
    "$context"|"$context"/*) fail "the secret environment file must be outside the repository and build context" ;;
  esac
}

assert_clean_checkout() {
  checkout=$1
  dirty=$(git -C "$checkout" status --porcelain=v1 --untracked-files=all)
  [ -z "$dirty" ] || fail "image build requires a clean checkout with no staged, unstaged, or untracked files"
}

assert_secret_context_protections() {
  ignore_file=$1
  expected_tail=$(printf '.env\n.env.*\n**/.env\n**/.env.*')
  actual_tail=$(awk 'NF && $1 !~ /^#/' "$ignore_file" | tail -n 4)
  [ "$actual_tail" = "$expected_tail" ] \
    || fail ".dockerignore environment exclusions must be the final effective rules"
  grep -Fq 'context: ${CAPSTONE_ASSISTIVE_WORKER_BUILD_CONTEXT:?' "$compose_file" \
    || fail "Compose does not require the verifier-owned clean build context"
  grep -Fq 'path: ${CAPSTONE_ASSISTIVE_WORKER_ENV_FILE:?' "$compose_file" \
    || fail "Compose does not require an external runtime environment file"
  if grep -Fxq 'COPY . .' "$repo_root/apps/assistive-worker/Dockerfile.hosted"; then
    fail "hosted Dockerfile uses an unbounded whole-context copy"
  fi
  grep -Fxq 'COPY apps/admin-cms apps/admin-cms' "$repo_root/apps/assistive-worker/Dockerfile.hosted" \
    || fail "hosted Dockerfile does not use the reviewed explicit runtime copy"
  grep -Fxq 'USER node' "$repo_root/apps/assistive-worker/Dockerfile.hosted" \
    || fail "hosted Dockerfile does not select the unprivileged runtime user"
}

assert_immutable_identity() {
  expected_id=$1
  actual_id=$2
  revision=$3
  commit=$4
  digest=${expected_id#sha256:}
  [ "$digest" != "$expected_id" ] || fail "accepted image ID is invalid"
  case "$digest" in *[!a-f0-9]*|'') fail "accepted image ID is invalid" ;; esac
  [ ${#digest} -eq 64 ] || fail "accepted image ID is invalid"
  [ "$actual_id" = "$expected_id" ] || fail "image identity differs from the accepted immutable image ID"
  [ "$revision" = "$commit" ] || fail "image revision label does not match the source commit"
}

env_value() {
  key=$1
  matches=$(awk -F= -v key="$key" '$1 == key { count += 1; value = substr($0, length(key) + 2) } END { if (count == 1) print value; else exit 1 }' "$env_file") \
    || fail "$key must occur exactly once in the external environment file"
  [ -n "$matches" ] || fail "$key must not be empty"
  case "$matches" in
    *'<'*|*'>'*) fail "$key still contains a placeholder" ;;
  esac
  printf '%s' "$matches"
}

acceptance_value() {
  key=$1
  awk -F= -v key="$key" '$1 == key { count += 1; value = substr($0, length(key) + 2) } END { if (count == 1 && value != "") print value; else exit 1 }' "$acceptance_file" \
    || fail "image acceptance record is missing or malformed"
}

self_test() {
  test_root=$(mktemp -d)
  temporary_build_context="$test_root"
  test_repo="$test_root/repo"
  mkdir -p "$test_repo"
  git -C "$test_repo" init -q
  git -C "$test_repo" config user.email 'profile-b-self-test@example.invalid'
  git -C "$test_repo" config user.name 'Profile B self-test'
  printf 'reviewed\n' >"$test_repo/tracked.txt"
  git -C "$test_repo" add tracked.txt
  git -C "$test_repo" commit -q -m baseline
  assert_clean_checkout "$test_repo"

  printf 'dirty\n' >>"$test_repo/tracked.txt"
  if (assert_clean_checkout "$test_repo" >/dev/null 2>&1); then
    fail "self-test accepted an unstaged tracked change"
  fi
  git -C "$test_repo" restore tracked.txt
  printf 'staged\n' >>"$test_repo/tracked.txt"
  git -C "$test_repo" add tracked.txt
  if (assert_clean_checkout "$test_repo" >/dev/null 2>&1); then
    fail "self-test accepted a staged tracked change"
  fi
  git -C "$test_repo" restore --staged tracked.txt
  git -C "$test_repo" restore tracked.txt
  printf 'untracked\n' >"$test_repo/untracked.txt"
  if (assert_clean_checkout "$test_repo" >/dev/null 2>&1); then
    fail "self-test accepted an untracked build-context file"
  fi
  rm -f -- "$test_repo/untracked.txt"

  printf 'placeholder\n' >"$test_repo/.env"
  if (assert_path_outside_context "$test_repo/.env" "$test_repo" >/dev/null 2>&1); then
    fail "self-test accepted a secret file inside the build context"
  fi
  printf 'placeholder\n' >"$test_root/external-worker.env"
  assert_path_outside_context "$test_root/external-worker.env" "$test_repo"

  valid_id='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  other_id='sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
  valid_commit='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  assert_immutable_identity "$valid_id" "$valid_id" "$valid_commit" "$valid_commit"
  if (assert_immutable_identity "$valid_id" "$other_id" "$valid_commit" "$valid_commit" >/dev/null 2>&1); then
    fail "self-test accepted a different container image ID"
  fi

  assert_secret_context_protections "$repo_root/.dockerignore"
  printf 'Profile B verifier self-test passed.\n'
}

case "$mode" in
  self-test)
    self_test
    exit 0
    ;;
  config|image|running) ;;
  *) fail "usage: sh verify.sh self-test | sh verify.sh [config|image|running] /absolute/path/to/worker.env" ;;
esac

[ -n "$env_file" ] || fail "an external worker environment file path is required"
command -v git >/dev/null 2>&1 || fail "git is required to verify the source identity"
command -v docker >/dev/null 2>&1 || fail "Docker is required"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
docker info >/dev/null 2>&1 || fail "the Docker daemon is not available"

env_file=$(canonical_file "$env_file")
assert_path_outside_context "$env_file" "$repo_root"
assert_secret_context_protections "$repo_root/.dockerignore"

expected_host=$(env_value CAPSTONE_EXPECTED_SUPABASE_HOST)
supabase_url=$(env_value CAPSTONE_ASSISTIVE_SUPABASE_URL)
secret_key=$(env_value SUPABASE_SECRET_KEY)
worker_id=$(env_value CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID)
deployment_version=$(env_value CAPSTONE_DEPLOYMENT_VERSION)

case "$expected_host" in
  *[!A-Za-z0-9.-]*|.*|*.) fail "CAPSTONE_EXPECTED_SUPABASE_HOST is not a canonical hostname" ;;
esac
[ "$supabase_url" = "https://$expected_host" ] || fail "the Supabase URL must exactly match the expected HTTPS host"
case "$worker_id" in
  ''|*[!A-Za-z0-9._:-]*|[!A-Za-z0-9]*) fail "CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID is invalid" ;;
esac
[ ${#worker_id} -le 128 ] || fail "CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID exceeds 128 characters"
case "$deployment_version" in
  *[!a-f0-9]*|'') fail "CAPSTONE_DEPLOYMENT_VERSION must be lowercase hexadecimal" ;;
esac
[ ${#deployment_version} -eq 40 ] || fail "CAPSTONE_DEPLOYMENT_VERSION must be a 40-character commit"
[ ${#secret_key} -ge 1 ] || fail "SUPABASE_SECRET_KEY must be present"
acceptance_file="${env_file}.image-acceptance.${deployment_version}"

source_commit=$(git -C "$repo_root" rev-parse HEAD)
case "$source_commit" in *[!a-f0-9]*|'') fail "HEAD is not a full hexadecimal commit" ;; esac
[ ${#source_commit} -eq 40 ] || fail "HEAD is not a full 40-character commit"
git -C "$repo_root" cat-file -e "${deployment_version}^{commit}" 2>/dev/null \
  || fail "deployment version is not a valid local commit"
[ "$deployment_version" = "$source_commit" ] || fail "deployment version does not match the checked-out source commit"

if [ "$mode" = image ]; then
  assert_clean_checkout "$repo_root"
  temporary_build_context=$(mktemp -d)
  git -C "$repo_root" archive --format=tar HEAD | tar -xf - -C "$temporary_build_context"
  build_context="$temporary_build_context"
else
  build_context="$repo_root"
fi
assert_path_outside_context "$env_file" "$build_context"

export CAPSTONE_ASSISTIVE_WORKER_ENV_FILE="$env_file"
export CAPSTONE_ASSISTIVE_WORKER_BUILD_CONTEXT="$build_context"
config_output=$(mktemp)
docker compose --project-directory "$script_dir" --env-file "$env_file" -f "$compose_file" config >"$config_output" \
  || fail "Docker Compose configuration is invalid"

service_count=$(docker compose --project-directory "$script_dir" --env-file "$env_file" -f "$compose_file" config --services | awk 'NF { count += 1 } END { print count + 0 }')
[ "$service_count" -eq 1 ] || fail "the Compose project must contain exactly one service"
grep -Eq '^  worker:$' "$config_output" || fail "the single service must be named worker"
if grep -Eq '^[[:space:]]+ports:' "$config_output"; then
  fail "published ports are forbidden"
fi
grep -Eq '^[[:space:]]+restart: unless-stopped$' "$config_output" || fail "restart policy is not unless-stopped"
grep -Eq '^[[:space:]]+pull_policy: never$' "$config_output" || fail "registry pulls are not disabled"
grep -Eq '^[[:space:]]+user: 1000:1000$' "$config_output" || fail "worker runtime is not pinned to the unprivileged user"
grep -Eq '^[[:space:]]+scale: 1$' "$config_output" || fail "worker scale is not exactly one"
grep -Fq 'CAPSTONE_ASSISTIVE_EXECUTION_MODE: CONTINUOUS' "$config_output" || fail "continuous execution mode is missing"

image="capstone-assistive-worker:$deployment_version"
if [ "$mode" = image ]; then
  docker compose --project-directory "$script_dir" --env-file "$env_file" -f "$compose_file" build worker
  image_id=$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null) \
    || fail "the expected local image is missing after build"
  revision=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")
  assert_immutable_identity "$image_id" "$image_id" "$revision" "$deployment_version"
  acceptance_temp="${acceptance_file}.tmp.$$"
  printf 'deployment_version=%s\nimage_id=%s\n' "$deployment_version" "$image_id" >"$acceptance_temp"
  mv -f -- "$acceptance_temp" "$acceptance_file"
  acceptance_temp=""
fi

if [ "$mode" = running ]; then
  [ -f "$acceptance_file" ] || fail "image acceptance record is missing; run image verification first"
  accepted_version=$(acceptance_value deployment_version)
  accepted_image_id=$(acceptance_value image_id)
  [ "$accepted_version" = "$deployment_version" ] || fail "accepted image deployment version differs from the configured commit"

  tagged_image_id=$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null) \
    || fail "the accepted local image is missing"
  revision=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")
  assert_immutable_identity "$accepted_image_id" "$tagged_image_id" "$revision" "$deployment_version"

  container_ids=$(docker compose --project-directory "$script_dir" --env-file "$env_file" -f "$compose_file" ps --status running -q worker)
  [ "$(printf '%s\n' "$container_ids" | awk 'NF { count += 1 } END { print count + 0 }')" -eq 1 ] \
    || fail "exactly one running worker container is required"
  container_image_id=$(docker inspect --format '{{.Image}}' "$container_ids")
  container_revision=$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container_ids")
  assert_immutable_identity "$accepted_image_id" "$container_image_id" "$container_revision" "$deployment_version"
  port_bindings=$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$container_ids")
  [ "$port_bindings" = '{}' ] || [ "$port_bindings" = 'null' ] || fail "the running worker publishes a port"
  runtime_user=$(docker inspect --format '{{.Config.User}}' "$container_ids")
  [ "$runtime_user" = '1000:1000' ] || fail "the running worker is not using the unprivileged user"
fi

printf 'Profile B %s verification passed for commit %s.\n' "$mode" "$deployment_version"
if [ "$mode" = image ]; then
  printf 'Accepted immutable image ID recorded beside the external environment file.\n'
fi
if [ "$mode" = running ]; then
  printf 'Container image ID matches acceptance; readiness still requires a fresh compatible staging heartbeat.\n'
fi
