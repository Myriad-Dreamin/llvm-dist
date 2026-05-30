#!/usr/bin/env bash
set -euo pipefail

echo "run build action on ${SCRIPT_LLVM_TAG} with ${SCRIPT_CMAKE_BUILD_TYPE}"

ninja -j"${SCRIPT_BUILD_JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu)}" "${SCRIPT_BUILD_TARGET:-all}"
