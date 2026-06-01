#!/usr/bin/env bash
set -euo pipefail

echo "run install action to ./dist on ${SCRIPT_LLVM_TAG} with ${SCRIPT_CMAKE_BUILD_TYPE}"

build_jobs="${SCRIPT_BUILD_JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu)}"

if [[ "${SCRIPT_STAGED_INSTALL:-0}" != "1" ]]; then
  cmake --build . --target "${SCRIPT_INSTALL_TARGET:-install-distribution}" --parallel "${build_jobs}"
  exit 0
fi

echo "staged install: build distribution before installing components"
cmake --build . --target distribution --parallel "${build_jobs}"

echo "staged install: remove object files before copying archives into dist"
find . -path ./dist -prune -o -path '*/CMakeFiles/*.dir' -type d -prune -exec rm -rf {} +
df -h . ./dist || true

IFS=';' read -r -a distribution_components <<<"${SCRIPT_LLVM_DISTRIBUTION_COMPONENTS}"
for component in "${distribution_components[@]}"; do
  if [[ -z "${component}" ]]; then
    continue
  fi
  cmake --install . --component "${component}"
done

echo "staged install: remove remaining object files after dist is populated"
find . -path ./dist -prune -o -type f \( -name '*.o' -o -name '*.dwo' \) -exec rm -f {} +
df -h . ./dist || true
