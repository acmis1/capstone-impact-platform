#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <image-name> <oci-archive>" >&2
  exit 2
fi

image_name="$1"
archive="$2"

fail() {
  echo "::error title=$1 OCI evidence::$*" >&2
  exit 1
}

if [[ ! -s "$archive" ]]; then
  fail "Missing $image_name" "$image_name OCI export is missing or empty: $archive"
fi

if ! index_json="$(tar -xOf "$archive" index.json)"; then
  fail "Unreadable $image_name" "$image_name OCI export does not contain a readable index.json: $archive"
fi

if ! descriptor="$(node -e '
const fs = require("node:fs");

try {
  const index = JSON.parse(fs.readFileSync(0, "utf8"));
  if (index.schemaVersion !== 2) throw new Error("schemaVersion");
  if (!Array.isArray(index.manifests) || index.manifests.length !== 1) throw new Error("manifest count");

  const manifest = index.manifests[0];
  if (manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json") throw new Error("media type");
  if (manifest.platform?.os !== "linux" || manifest.platform?.architecture !== "amd64") throw new Error("platform");
  if (typeof manifest.digest !== "string") throw new Error("digest");

  process.stdout.write([
    manifest.digest,
    manifest.mediaType,
    manifest.platform.os,
    manifest.platform.architecture,
  ].join("\t"));
} catch {
  process.exit(1);
}
' <<<"$index_json")"; then
  fail "Invalid $image_name" "$image_name OCI index is not one linux/amd64 OCI image manifest"
fi

IFS=$'\t' read -r digest media_type platform_os platform_architecture <<<"$descriptor"
if [[ "$media_type" != "application/vnd.oci.image.manifest.v1+json" || "$platform_os" != "linux" || "$platform_architecture" != "amd64" ]]; then
  fail "Invalid $image_name" "$image_name OCI descriptor is not linux/amd64"
fi

if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  fail "Malformed $image_name" "$image_name digest is not sha256:<64 lowercase hex>: $digest"
fi

digest_hex="${digest#sha256:}"
blob_path="blobs/sha256/$digest_hex"
if ! tar -tf "$archive" | grep -Fx "$blob_path" > /dev/null; then
  fail "Missing $image_name manifest blob" "$image_name digest is not present in the OCI layout: $digest"
fi

if ! actual_digest="$(tar -xOf "$archive" "$blob_path" | sha256sum | awk '{print $1}')"; then
  fail "Unreadable $image_name manifest blob" "$image_name manifest blob cannot be read: $digest"
fi
if [[ "$actual_digest" != "$digest_hex" ]]; then
  fail "Invalid $image_name manifest blob" "$image_name manifest blob does not match its descriptor: $digest"
fi

printf '%s\n' "$digest"
