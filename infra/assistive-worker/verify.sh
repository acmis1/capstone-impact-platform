#!/bin/sh
set -eu

umask 077
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
mode=${1:-config}
env_file=${2:-}
profile=${3:-staging}
case "$profile" in
  staging) compose_file="$script_dir/compose.yaml" ;;
  production) compose_file="$script_dir/compose.production.yaml" ;;
  *) printf 'Profile B verification failed: profile must be staging or production\n' >&2; exit 1 ;;
esac
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

assert_linux_amd64_platform() {
  platform=$1
  [ "$platform" = 'linux/amd64' ] \
    || fail "the currently qualified Profile B worker requires a linux/amd64 Docker engine; detected '$platform'. Use a Linux amd64 host; ARM and emulation are not qualified"
}

assert_docker_engine_architecture() {
  engine_platform=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}' 2>/dev/null) \
    || fail "could not determine the Docker engine platform; the currently qualified Profile B worker requires linux/amd64"
  assert_linux_amd64_platform "$engine_platform"
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
  grep -Fxq 'RUN npm run build:assistive-worker --workspace=apps/admin-cms' \
    "$repo_root/apps/assistive-worker/Dockerfile.hosted" \
    || fail "hosted Dockerfile does not build the reviewed coordinator bundle"
  grep -Fxq 'COPY --from=coordinator-build /app/apps/admin-cms/dist/assistive-worker.cjs /app/apps/admin-cms/src/scripts/assistive-worker.cjs' \
    "$repo_root/apps/assistive-worker/Dockerfile.hosted" \
    || fail "hosted Dockerfile does not copy only the bundled coordinator into the runtime image"
  grep -Fxq 'COPY --from=coordinator-build /app/apps/admin-cms/dist/assistive-worker-on-demand.cjs /app/apps/admin-cms/src/scripts/assistive-worker-on-demand.cjs' \
    "$repo_root/apps/assistive-worker/Dockerfile.hosted" \
    || fail "hosted Dockerfile does not copy the bundled on-demand coordinator into the runtime image"
  [ "$(grep -Fc 'RUN npm ci --ignore-scripts' "$repo_root/apps/assistive-worker/Dockerfile.hosted")" -eq 1 ] \
    || fail "hosted Dockerfile must install npm dependencies only in its build stage"
  grep -Fxq 'ENTRYPOINT ["capstone-credential-boundary", "/usr/bin/tini", "--"]' \
    "$repo_root/apps/assistive-worker/Dockerfile.hosted" \
    || fail "hosted Dockerfile does not run its init inside the credential-boundary launcher"
  grep -Fxq 'COPY --from=provider-build /opt/capstone/bin/libcapstone-credential-boundary.so /usr/local/lib/libcapstone-credential-boundary.so' \
    "$repo_root/apps/assistive-worker/Dockerfile.hosted" \
    || fail "hosted Dockerfile does not copy the post-exec credential-boundary shim"
  grep -Fxq 'ENV LD_PRELOAD=/usr/local/lib/libcapstone-credential-boundary.so' \
    "$repo_root/apps/assistive-worker/Dockerfile.hosted" \
    || fail "hosted Dockerfile does not enforce the credential boundary after exec"
  grep -Fq "spawnSync('/bin/cat', ['/proc/' + process.pid + '/environ']" \
    "$repo_root/apps/assistive-worker/Dockerfile.hosted" \
    || fail "hosted Dockerfile does not test the credential boundary after exec"
  grep -Fxq 'CMD ["node", "apps/admin-cms/src/scripts/assistive-worker.cjs"]' \
    "$repo_root/apps/assistive-worker/Dockerfile.hosted" \
    || fail "hosted Dockerfile runtime command is not the bundled coordinator"
  grep -Fxq 'USER node' "$repo_root/apps/assistive-worker/Dockerfile.hosted" \
    || fail "hosted Dockerfile does not select the unprivileged runtime user"
}

assert_compose_profile() {
  file=$1
  identity=$2
  grep -Fq "CAPSTONE_RUNTIME_ENV: $identity" "$file" \
    || fail "$identity Compose profile does not pin its runtime identity"
  grep -Fq 'CAPSTONE_ASSISTIVE_EXECUTION_MODE: CONTINUOUS' "$file" \
    || fail "$identity Compose profile is not continuous-only"
  grep -Fq 'pull_policy: never' "$file" || fail "$identity Compose profile permits registry pulls"
  grep -Fq 'user: "1000:1000"' "$file" || fail "$identity Compose profile is not unprivileged"
  grep -Fq 'init: false' "$file" || fail "$identity Compose profile injects an init outside the credential boundary"
  grep -Fq 'read_only: true' "$file" || fail "$identity Compose profile root filesystem is writable"
  grep -Fq 'pids_limit: 256' "$file" || fail "$identity Compose profile has no bounded PID limit"
  grep -Fq '      - ALL' "$file" || fail "$identity Compose profile does not drop all capabilities"
  grep -Fq '      - "no-new-privileges:true"' "$file" \
    || fail "$identity Compose profile permits privilege gain"
  grep -Fq '      - /tmp:rw,noexec,nosuid,nodev,size=1073741824,uid=1000,gid=1000,mode=1777' "$file" \
    || fail "$identity Compose profile lacks the bounded writable task filesystem"
  grep -Fq 'cpus: 2' "$file" || fail "$identity Compose profile lost the two-CPU limit"
  grep -Fq 'mem_limit: 4g' "$file" || fail "$identity Compose profile lost the four-GiB memory limit"
  grep -Fq 'stop_grace_period: 10m' "$file" || fail "$identity Compose profile lost graceful stop"
  grep -Fq 'scale: 1' "$file" || fail "$identity Compose profile is not scale one"
  if grep -Eq '^[[:space:]]+(cap_add|privileged|entrypoint|LD_PRELOAD):' "$file"; then
    fail "$identity Compose profile overrides the reviewed privilege or credential-boundary contract"
  fi
  if grep -Eq '^[[:space:]]+ports:' "$file"; then
    fail "$identity Compose profile publishes ports"
  fi
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

assert_no_runtime_boundary_overrides() {
  file=$1
  if grep -Eq '^[[:space:]]*LD_PRELOAD[[:space:]]*=' "$file"; then
    fail "the external environment file must not override the image credential-boundary preload"
  fi
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
  assert_no_runtime_boundary_overrides "$test_root/external-worker.env"
  printf 'LD_PRELOAD=/tmp/unreviewed.so\n' >>"$test_root/external-worker.env"
  if (assert_no_runtime_boundary_overrides "$test_root/external-worker.env" >/dev/null 2>&1); then
    fail "self-test accepted an external LD_PRELOAD override"
  fi
  printf 'placeholder\n' >"$test_root/external-worker.env"

  valid_id='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  other_id='sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
  valid_commit='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  assert_immutable_identity "$valid_id" "$valid_id" "$valid_commit" "$valid_commit"
  if (assert_immutable_identity "$valid_id" "$other_id" "$valid_commit" "$valid_commit" >/dev/null 2>&1); then
    fail "self-test accepted a different container image ID"
  fi

  assert_linux_amd64_platform 'linux/amd64'
  architecture_failure=$( (assert_linux_amd64_platform 'linux/arm64') 2>&1 || true )
  printf '%s' "$architecture_failure" | grep -Fq 'linux/amd64' \
    || fail "self-test did not reject a non-amd64 Docker engine with the qualified architecture message"
  printf '%s' "$architecture_failure" | grep -Fq 'ARM and emulation are not qualified' \
    || fail "self-test architecture message did not explain the unsupported ARM/emulation path"

  assert_secret_context_protections "$repo_root/.dockerignore"
  assert_compose_profile "$script_dir/compose.yaml" staging
  assert_compose_profile "$script_dir/compose.production.yaml" production
  grep -Fq 'CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED: ${CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED:?' \
    "$script_dir/compose.production.yaml" \
    || fail "production Compose profile does not require the production capability"
  if grep -Fq 'CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED' "$script_dir/compose.yaml"; then
    fail "staging Compose profile was broadened with the production capability"
  fi
  printf 'Profile B verifier self-test passed.\n'
}

case "$mode" in
  self-test)
    self_test
    exit 0
    ;;
  config|image|running) ;;
  *) fail "usage: sh verify.sh self-test | sh verify.sh [config|image|running] /absolute/path/to/worker.env [staging|production]" ;;
esac

[ -n "$env_file" ] || fail "an external worker environment file path is required"
command -v git >/dev/null 2>&1 || fail "git is required to verify the source identity"
command -v docker >/dev/null 2>&1 || fail "Docker is required"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
docker info >/dev/null 2>&1 || fail "the Docker daemon is not available"
assert_docker_engine_architecture

env_file=$(canonical_file "$env_file")
assert_path_outside_context "$env_file" "$repo_root"
assert_no_runtime_boundary_overrides "$env_file"
assert_secret_context_protections "$repo_root/.dockerignore"

expected_host=$(env_value CAPSTONE_EXPECTED_SUPABASE_HOST)
supabase_url=$(env_value CAPSTONE_ASSISTIVE_SUPABASE_URL)
secret_key=$(env_value SUPABASE_SECRET_KEY)
worker_id=$(env_value CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID)
deployment_version=$(env_value CAPSTONE_DEPLOYMENT_VERSION)
if [ "$profile" = production ]; then
  production_capability=$(env_value CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED)
  [ "$production_capability" = true ] \
    || fail "CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED must be exactly true for the production profile"
fi

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
grep -Eq '^[[:space:]]+init: false$' "$config_output" || fail "worker injects an init outside the credential boundary"
grep -Eq '^[[:space:]]+read_only: true$' "$config_output" || fail "worker root filesystem is writable"
grep -Eq '^[[:space:]]+pids_limit: 256$' "$config_output" || fail "worker PID limit is not 256"
grep -Fq '    - ALL' "$config_output" || fail "worker capabilities are not fully dropped"
grep -Fq '    - no-new-privileges:true' "$config_output" || fail "worker can gain new privileges"
grep -Fq '/tmp:rw,noexec,nosuid,nodev,size=1073741824,uid=1000,gid=1000,mode=1777' "$config_output" \
  || fail "worker bounded writable task filesystem is missing"
grep -Eq '^[[:space:]]+cpus: (2|2\.0)$' "$config_output" || fail "worker CPU limit is not two cores"
grep -Eq '^[[:space:]]+mem_limit: "?4294967296"?$' "$config_output" || fail "worker memory limit is not four GiB"
grep -Eq '^[[:space:]]+scale: 1$' "$config_output" || fail "worker scale is not exactly one"
grep -Fq 'CAPSTONE_ASSISTIVE_EXECUTION_MODE: CONTINUOUS' "$config_output" || fail "continuous execution mode is missing"
grep -Fq "CAPSTONE_RUNTIME_ENV: $profile" "$config_output" || fail "runtime identity differs from the selected profile"
if [ "$profile" = production ]; then
  grep -Fq 'CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED: "true"' "$config_output" \
    || fail "production capability is not exactly true"
fi

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
  injected_init=$(docker inspect --format '{{.HostConfig.Init}}' "$container_ids")
  [ "$injected_init" = false ] || fail "the running worker injects an init outside the credential boundary"
  runtime_path=$(docker inspect --format '{{.Path}}' "$container_ids")
  runtime_args=$(docker inspect --format '{{json .Args}}' "$container_ids")
  [ "$runtime_path" = 'capstone-credential-boundary' ] \
    && [ "$runtime_args" = '["/usr/bin/tini","--","node","apps/admin-cms/src/scripts/assistive-worker.cjs"]' ] \
    || fail "the running worker bypasses the reviewed credential-boundary/init chain"
  read_only_root=$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$container_ids")
  [ "$read_only_root" = true ] || fail "the running worker root filesystem is writable"
  pids_limit=$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$container_ids")
  [ "$pids_limit" = 256 ] || fail "the running worker PID limit is not 256"
  nano_cpus=$(docker inspect --format '{{.HostConfig.NanoCpus}}' "$container_ids")
  [ "$nano_cpus" = 2000000000 ] || fail "the running worker CPU limit is not two cores"
  memory_limit=$(docker inspect --format '{{.HostConfig.Memory}}' "$container_ids")
  [ "$memory_limit" = 4294967296 ] || fail "the running worker memory limit is not four GiB"
  privileged=$(docker inspect --format '{{.HostConfig.Privileged}}' "$container_ids")
  [ "$privileged" = false ] || fail "the running worker is privileged"
  cap_drop=$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$container_ids")
  [ "$cap_drop" = '["ALL"]' ] || fail "the running worker does not drop all capabilities"
  cap_add=$(docker inspect --format '{{json .HostConfig.CapAdd}}' "$container_ids")
  [ "$cap_add" = 'null' ] || [ "$cap_add" = '[]' ] || fail "the running worker adds capabilities"
  security_options=$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$container_ids")
  printf '%s' "$security_options" | grep -Fq 'no-new-privileges:true' \
    || fail "the running worker permits privilege gain"
  tmpfs_options=$(docker inspect --format '{{ index .HostConfig.Tmpfs "/tmp" }}' "$container_ids")
  normalized_tmpfs=$(printf '%s' "$tmpfs_options" | tr ',' '\n' | LC_ALL=C sort | tr '\n' ',')
  [ "$normalized_tmpfs" = 'gid=1000,mode=1777,nodev,noexec,nosuid,rw,size=1073741824,uid=1000,' ] \
    || fail "the running worker bounded writable task filesystem options differ"
  preload=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_ids" \
    | awk -F= '$1 == "LD_PRELOAD" { count += 1; value = substr($0, length($1) + 2) } END { if (count == 1) print value; else exit 1 }') \
    || fail "the running worker credential-boundary preload is missing or duplicated"
  [ "$preload" = '/usr/local/lib/libcapstone-credential-boundary.so' ] \
    || fail "the running worker credential-boundary preload differs from the reviewed library"
fi

printf 'Profile B %s verification passed for commit %s.\n' "$mode" "$deployment_version"
if [ "$mode" = image ]; then
  printf 'Accepted immutable image ID recorded beside the external environment file.\n'
fi
if [ "$mode" = running ]; then
  printf 'Container image ID matches acceptance; readiness still requires a fresh compatible %s heartbeat.\n' "$profile"
fi
