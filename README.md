# llvm-dist

LLVM distribution build orchestration for our release artifacts.

This repository replaces the legacy Python
`build-llvm-toolchains.py` flow with a TypeScript CLI and ccache-aware
build scripts. The default build plan preserves the old allow-list
versions:

- `15.0.7`
- `21.1.8`

The generated LLVM distribution components include the clang and clang-tidy
libraries used by clice, plus our extra `clang-repl` component.

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

The action scripts receive these environment variables from the TypeScript
runner:

- `SCRIPT_LLVM_TAG`
- `SCRIPT_STD_BUILD_TYPE`
- `SCRIPT_CMAKE_BUILD_TYPE`
- `SCRIPT_LLVM_DISTRIBUTION_COMPONENTS`
- `SCRIPT_ENABLE_CCACHE`
- `SCRIPT_CCACHE_DIR`
- `SCRIPT_BUILD_JOBS`

## Workflows

- `CI` runs only formatting and tests.
- `Build LLVM Artifacts` builds `release` and `relwithdebinfo` Linux artifacts,
  restores/saves ccache, uploads workflow artifacts, and can publish those
  archives to a GitHub Release when run from a tag or with `publish_release`.
