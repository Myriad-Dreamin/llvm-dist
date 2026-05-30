#!/usr/bin/env bash
set -euo pipefail

if [[ ! -d dist ]]; then
  echo "dist directory does not exist: ${PWD}/dist" >&2
  exit 1
fi

artifact_dir="${SCRIPT_ARTIFACT_DIR:-${PWD}/artifacts}"
mkdir -p "${artifact_dir}"

package_name="${SCRIPT_PACKAGE_PREFIX:-llvm-dist}-${SCRIPT_LLVM_TAG}-${SCRIPT_STD_BUILD_TYPE}-${SCRIPT_PACKAGE_PLATFORM:-$(uname -s)-$(uname -m)}"
archive_path="${artifact_dir}/${package_name}.tar.xz"

echo "run package action for ${SCRIPT_LLVM_TAG} with ${SCRIPT_CMAKE_BUILD_TYPE}"
tar -C dist -cJf "${archive_path}" .

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${archive_path}" >"${archive_path}.sha256"
else
  shasum -a 256 "${archive_path}" >"${archive_path}.sha256"
fi
