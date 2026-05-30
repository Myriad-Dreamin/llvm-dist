#!/usr/bin/env bash
set -euo pipefail

echo "run install action to ./dist on ${SCRIPT_LLVM_TAG} with ${SCRIPT_CMAKE_BUILD_TYPE}"

cmake --build . --target "${SCRIPT_INSTALL_TARGET:-install-distribution}" --parallel "${SCRIPT_BUILD_JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu)}"
