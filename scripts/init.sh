#!/usr/bin/env bash
set -euo pipefail

echo "run init action on ${SCRIPT_LLVM_TAG} with ${SCRIPT_CMAKE_BUILD_TYPE}"
echo "target triples: ${SCRIPT_TARGET_TRIPLES:-unspecified}"
echo "LLVM targets to build: ${SCRIPT_LLVM_TARGETS_TO_BUILD:-X86}"
echo "experimental LLVM targets to build: ${SCRIPT_LLVM_EXPERIMENTAL_TARGETS_TO_BUILD:-none}"
echo "C compiler: ${SCRIPT_C_COMPILER:-default}"
echo "CXX compiler: ${SCRIPT_CXX_COMPILER:-default}"
echo "ASM compiler: ${SCRIPT_ASM_COMPILER:-default}"

rm -f CMakeCache.txt

cmake_args=(
  "../../llvm"
  "-G"
  "Ninja"
  "-DCMAKE_BUILD_TYPE=${SCRIPT_CMAKE_BUILD_TYPE}"
  "-DLLVM_INCLUDE_EXAMPLES=OFF"
  "-DLLVM_INCLUDE_TESTS=OFF"
  "-DLLVM_ENABLE_ZLIB=ON"
  "-DLLVM_ENABLE_ZSTD=ON"
  "-DLLVM_ENABLE_PROJECTS=${SCRIPT_LLVM_ENABLE_PROJECTS:-clang;clang-tools-extra;compiler-rt;lld;mlir}"
  "-DLLVM_TARGETS_TO_BUILD=${SCRIPT_LLVM_TARGETS_TO_BUILD:-X86}"
  "-DLLVM_DISTRIBUTION_COMPONENTS=${SCRIPT_LLVM_DISTRIBUTION_COMPONENTS}"
  "-DCMAKE_INSTALL_PREFIX=${PWD}/dist"
)

if [[ -n "${SCRIPT_LLVM_EXPERIMENTAL_TARGETS_TO_BUILD:-}" ]]; then
  cmake_args+=(
    "-DLLVM_EXPERIMENTAL_TARGETS_TO_BUILD=${SCRIPT_LLVM_EXPERIMENTAL_TARGETS_TO_BUILD}"
  )
fi

if [[ -n "${SCRIPT_C_COMPILER:-}" ]]; then
  cmake_args+=("-DCMAKE_C_COMPILER=${SCRIPT_C_COMPILER}")
fi

if [[ -n "${SCRIPT_CXX_COMPILER:-}" ]]; then
  cmake_args+=("-DCMAKE_CXX_COMPILER=${SCRIPT_CXX_COMPILER}")
fi

if [[ -n "${SCRIPT_ASM_COMPILER:-}" ]]; then
  cmake_args+=("-DCMAKE_ASM_COMPILER=${SCRIPT_ASM_COMPILER}")
fi

if [[ -n "${SCRIPT_CMAKE_EXTRA_ARGS:-}" ]]; then
  read -r -a extra_cmake_args <<<"${SCRIPT_CMAKE_EXTRA_ARGS}"
  cmake_args+=("${extra_cmake_args[@]}")
fi

cmake "${cmake_args[@]}"
