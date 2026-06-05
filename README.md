# llvm-dist

LLVM distribution build orchestration for our release artifacts.

This repository replaces the legacy Python
`build-llvm-toolchains.py` flow with a TypeScript CLI and build scripts. The
default build plan preserves the old allow-list versions:

- `15.0.7`
- `21.1.8`

The generated LLVM distribution components include the clang and clang-tidy
libraries used by clice and their static-library export dependencies. The
`clang-repl` executable and `clangInterpreter` dependency closure are not built
or packaged by the default release workflow.

Target triples are mirrored from the Rust-style target triples used by tinymist
releases. The default target triples are:

- `x86_64-pc-windows-msvc`
- `x86_64-unknown-linux-gnu`
- `x86_64-unknown-linux-musl`
- `x86_64-apple-darwin`
- `aarch64-apple-darwin`
- `aarch64-pc-windows-msvc`
- `aarch64-unknown-linux-gnu`
- `arm-unknown-linux-musleabihf`
- `armv7-unknown-linux-musleabihf`
- `riscv64gc-unknown-linux-musl`
- `loongarch64-unknown-linux-musl`

Across the full target set, those triples cover the LLVM backends
`X86;AArch64;ARM;RISCV;LoongArch`. Each single-target build only exports the
backend required by that target triple. Print the current mapping with:

```bash
pnpm llvm targets
```

When `--target-triples` is omitted, the CLI defaults to the current platform's
target triple.

When building LLVM 15.x, `LoongArch` is passed through
`LLVM_EXPERIMENTAL_TARGETS_TO_BUILD` instead of `LLVM_TARGETS_TO_BUILD`.

Artifacts are split by component profile to stay below GitHub artifact limits:

- `llvm-core`
- `clang-sdk`
- `clang-tooling`
- `clang-tidy`
- `pdb`, generated only when `.pdb` files are present

There is intentionally no `full` artifact.

## Local Commands

```bash
pnpm install
pnpm run format:check
pnpm test
```

Print the LLVM build plan:

```bash
pnpm llvm plan --llvm-dir llvm-mainline
```

Configure, build, install, and package one LLVM version:

```bash
pnpm llvm init --llvm-dir llvm-mainline --allow 21.1.8 --build-types relwithdebinfo
pnpm llvm install --llvm-dir llvm-mainline --allow 21.1.8 --build-types relwithdebinfo
pnpm llvm package --llvm-dir llvm-mainline --allow 21.1.8 --build-types relwithdebinfo
```

Generate a descriptor for every archive under `artifacts/` and refresh matching
`.sha256` files:

```bash
pnpm llvm descriptor --artifact-dir artifacts
```

Each package filename includes the profile and target triple:

```text
llvm-dist-llvm-core-llvmorg-21.1.8-relwithdebinfo-x86_64-unknown-linux-gnu.tar.xz
llvm-dist-clang-sdk-llvmorg-21.1.8-relwithdebinfo-x86_64-unknown-linux-gnu.tar.xz
llvm-dist-clang-tooling-llvmorg-21.1.8-relwithdebinfo-x86_64-unknown-linux-gnu.tar.xz
llvm-dist-clang-tidy-llvmorg-21.1.8-relwithdebinfo-x86_64-unknown-linux-gnu.tar.xz
llvm-dist-pdb-llvmorg-21.1.8-relwithdebinfo-x86_64-pc-windows-msvc.tar.xz
```

The action scripts receive these environment variables from the TypeScript
runner:

- `SCRIPT_LLVM_TAG`
- `SCRIPT_STD_BUILD_TYPE`
- `SCRIPT_CMAKE_BUILD_TYPE`
- `SCRIPT_TARGET_TRIPLES`
- `SCRIPT_LLVM_DISTRIBUTION_COMPONENTS`
- `SCRIPT_LLVM_EXPERIMENTAL_TARGETS_TO_BUILD`
- `SCRIPT_LLVM_TARGETS_TO_BUILD`
- `SCRIPT_C_COMPILER`
- `SCRIPT_CXX_COMPILER`
- `SCRIPT_ASM_COMPILER`
- `SCRIPT_CMAKE_EXTRA_ARGS`
- `SCRIPT_PACKAGE_TARGET`
- `SCRIPT_BUILD_JOBS`

## Workflows

- `CI` runs only formatting and tests.
- `Build LLVM Artifacts` builds `release` and `relwithdebinfo` artifacts for the
  configured target triples. Native Linux, Windows, and Darwin targets build on
  matching GitHub runners; non-native Linux targets build inside
  `ghcr.io/cross-rs/<target-triple>:edge` containers. The Linux cross job
  resolves the target compiler pair inside each container and passes full
  C/C++/ASM compiler paths to CMake. Job names, workflow artifact names, and
  package filenames use target triples directly. Workflow dispatches default to
  `batch-1`, and each batch builds at most two target triples:
  `batch-1` builds `x86_64-unknown-linux-gnu` and
  `x86_64-pc-windows-msvc`; `batch-2` builds `aarch64-apple-darwin` and
  `x86_64-apple-darwin`; `batch-3` builds `aarch64-unknown-linux-gnu` and
  `x86_64-unknown-linux-musl`; `batch-4` builds `aarch64-pc-windows-msvc`
  and `armv7-unknown-linux-musleabihf`; `batch-5` builds
  `arm-unknown-linux-musleabihf` and `riscv64gc-unknown-linux-musl`; `batch-6`
  builds `loongarch64-unknown-linux-musl`. Tag pushes build `all` batches. The
  LLVM source checkout uses `actions/checkout` with `fetch-depth: 1` and
  `filter: blob:none` to reduce checkout size. The workflow uploads split
  artifacts, generates a `descriptor.json` containing every archive from the
  current run for `all` builds, and can publish those archives plus checksums to
  a GitHub Release. For batched release publishing, run `batch-1` through
  `batch-5` with `publish_release` enabled to upload each batch's archives to
  the same release tag, then run `batch-6` with `publish_release` enabled.
  `batch-6` downloads the existing release archives, merges them with its own
  current-run archives, and publishes the complete `descriptor.json` plus
  checksums.
