import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  BUILD_TYPE_TO_CMAKE,
  CLICE_LLVM_COMPONENTS,
  DEFAULT_TARGET_TRIPLES,
  DEFAULT_LLVM_TARGETS_TO_BUILD,
  DEFAULT_PACKAGE_PROFILES,
  EXTRA_LLVM_COMPONENTS,
  LLVM_DISTRIBUTION_COMPONENTS,
  LLVM_PACKAGE_PROFILES,
  buildCMakeDistributionComponents,
  createArtifactDescriptor,
  createBuildPlan,
  defaultTargetTriplesForPlatform,
  experimentalLlvmTargetsToBuildForVersion,
  targetTripleForPlatform,
  llvmTargetsToBuildForTriples,
  parseVersionTag,
  stableLlvmTargetsToBuildForVersion,
  tagSuffixToPathSuffix,
} from "../src/build-llvm-toolchains.js";

describe("parseVersionTag", () => {
  it("parses release tags and keeps the release suffix marker internal", () => {
    expect(parseVersionTag("llvmorg", "llvmorg-21.1.8")).toEqual({
      prefix: "llvmorg",
      version: [21, 1, 8],
      suffix: "-rcN",
      raw: "llvmorg-21.1.8",
    });
  });

  it("parses rc tags", () => {
    expect(parseVersionTag("build", "build-21.1.8-rc2")).toEqual({
      prefix: "build",
      version: [21, 1, 8],
      suffix: "-rc2",
      raw: "build-21.1.8-rc2",
    });
  });

  it("normalizes release suffixes for worktree paths", () => {
    expect(tagSuffixToPathSuffix("-rcN")).toBe("");
    expect(tagSuffixToPathSuffix("-rc3")).toBe("-rc3");
  });
});

describe("createBuildPlan", () => {
  it("selects allowed latest release tags and both default build types", () => {
    const plan = createBuildPlan({
      worktreeEntries: ["build-21.1.8-rc1", "build-15.0.7"],
      llvmTags: [
        "llvmorg-9.0.1",
        "llvmorg-15.0.7",
        "llvmorg-21.1.8-rc1",
        "llvmorg-21.1.8",
        "llvmorg-22.0.0",
      ],
      allowList: [
        [15, 0, 7],
        [21, 1, 8],
      ],
    });

    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks.map((task) => task.llvmTag)).toEqual(["llvmorg-21.1.8", "llvmorg-15.0.7"]);
    expect(plan.tasks[0]?.worktree).toBe("build-21.1.8");
    expect(plan.tasks[0]?.buildTypes).toEqual(["release", "relwithdebinfo"]);
    expect(plan.tasks[0]?.matchedWorktree).toEqual({
      buildSuffix: "-rc1",
      tagSuffix: "-rcN",
    });
  });

  it("can plan a single build type and manual downstream target", () => {
    const plan = createBuildPlan({
      worktreeEntries: [],
      llvmTags: ["llvmorg-21.1.8"],
      allowList: [[21, 1, 8]],
      buildTypes: ["relwithdebinfo"],
      manualList: [{ worktree: "build-kfuzz", llvmTag: "build-kfuzz" }],
    });

    expect(plan.tasks).toEqual([
      {
        kind: "auto",
        version: [21, 1, 8],
        suffix: "",
        llvmTag: "llvmorg-21.1.8",
        worktree: "build-21.1.8",
        buildTypes: ["relwithdebinfo"],
        matchedWorktree: undefined,
      },
      {
        kind: "manual",
        suffix: "build-kfuzz",
        llvmTag: "build-kfuzz",
        worktree: "build-kfuzz",
        buildTypes: ["relwithdebinfo"],
      },
    ]);
  });
});

describe("distribution components", () => {
  it("keeps package profiles split by category without a full package", () => {
    expect(DEFAULT_PACKAGE_PROFILES).toEqual([
      "llvm-core",
      "clang-sdk",
      "clang-tooling",
      "clang-tidy",
      "clang-repl",
    ]);
    expect(DEFAULT_PACKAGE_PROFILES).not.toContain("full");
    expect(
      LLVM_PACKAGE_PROFILES.find((profile) => profile.name === "llvm-core")?.components,
    ).toContain("LLVMSupport");
    expect(
      LLVM_PACKAGE_PROFILES.find((profile) => profile.name === "clang-tooling")?.dependsOn,
    ).toEqual(["llvm-core", "clang-sdk"]);
  });

  it("contains clice-linked components plus clang-repl", () => {
    expect(CLICE_LLVM_COMPONENTS).toContain("clangToolingInclusions");
    expect(CLICE_LLVM_COMPONENTS).toContain("clangTidyReadabilityModule");
    expect(EXTRA_LLVM_COMPONENTS).toEqual(["clang-repl"]);
    expect(LLVM_DISTRIBUTION_COMPONENTS).toContain("clang-repl");
    expect(new Set(LLVM_DISTRIBUTION_COMPONENTS).size).toBe(LLVM_DISTRIBUTION_COMPONENTS.length);
  });

  it("includes the static-library export closure required by LLVM 21", () => {
    expect(
      LLVM_PACKAGE_PROFILES.find((profile) => profile.name === "llvm-core")?.components,
    ).toEqual(expect.arrayContaining(["LLVMDemangle", "LLVMCore", "LLVMMCParser", "LLVMObject"]));
    expect(
      LLVM_PACKAGE_PROFILES.find((profile) => profile.name === "clang-sdk")?.components,
    ).toEqual(expect.arrayContaining(["clangAPINotes", "clangSupport"]));
    expect(
      LLVM_PACKAGE_PROFILES.find((profile) => profile.name === "clang-tooling")?.components,
    ).toContain("clangRewrite");
    expect(
      LLVM_PACKAGE_PROFILES.find((profile) => profile.name === "clang-tidy")?.components,
    ).toEqual(
      expect.arrayContaining([
        "clangAnalysisFlowSensitive",
        "clangIncludeCleaner",
        "clangStaticAnalyzerCore",
        "clangStaticAnalyzerFrontend",
        "clangTransformer",
      ]),
    );
  });

  it("formats distribution components for CMake", () => {
    const cmakeValue = buildCMakeDistributionComponents();
    expect(cmakeValue).toContain("LLVMSupport;LLVMFrontendOpenMP");
    expect(cmakeValue.endsWith(";clang-repl")).toBe(true);
  });
});

describe("target triples", () => {
  it("tracks target triples and derives LLVM backend names", () => {
    expect(DEFAULT_TARGET_TRIPLES.map((target) => target.triple)).toEqual([
      "x86_64-pc-windows-msvc",
      "x86_64-unknown-linux-gnu",
      "x86_64-unknown-linux-musl",
      "x86_64-apple-darwin",
      "aarch64-apple-darwin",
      "aarch64-pc-windows-msvc",
      "aarch64-unknown-linux-gnu",
      "arm-unknown-linux-musleabihf",
      "armv7-unknown-linux-musleabihf",
      "riscv64gc-unknown-linux-musl",
      "loongarch64-unknown-linux-musl",
    ]);
    expect(DEFAULT_LLVM_TARGETS_TO_BUILD).toEqual(["X86", "AArch64", "ARM", "RISCV", "LoongArch"]);
    expect(
      llvmTargetsToBuildForTriples([
        "x86_64-unknown-linux-gnu",
        "aarch64-unknown-linux-gnu",
        "armv7-unknown-linux-musleabihf",
      ]),
    ).toEqual(["X86", "AArch64", "ARM"]);
  });

  it("infers triples from package platform aliases", () => {
    expect(targetTripleForPlatform("linux-x64")).toBe("x86_64-unknown-linux-gnu");
    expect(targetTripleForPlatform("win32-arm64")).toBe("aarch64-pc-windows-msvc");
    expect(targetTripleForPlatform("x86_64-unknown-linux-musl")).toBe("x86_64-unknown-linux-musl");
    expect(defaultTargetTriplesForPlatform("linux-x64")).toEqual(["x86_64-unknown-linux-gnu"]);
  });

  it("keeps LoongArch experimental for LLVM 15 builds", () => {
    expect(stableLlvmTargetsToBuildForVersion(DEFAULT_LLVM_TARGETS_TO_BUILD, [15, 0, 7])).toEqual([
      "X86",
      "AArch64",
      "ARM",
      "RISCV",
    ]);
    expect(
      experimentalLlvmTargetsToBuildForVersion(DEFAULT_LLVM_TARGETS_TO_BUILD, [15, 0, 7]),
    ).toEqual(["LoongArch"]);
    expect(stableLlvmTargetsToBuildForVersion(DEFAULT_LLVM_TARGETS_TO_BUILD, [21, 1, 8])).toEqual(
      DEFAULT_LLVM_TARGETS_TO_BUILD,
    );
    expect(
      experimentalLlvmTargetsToBuildForVersion(DEFAULT_LLVM_TARGETS_TO_BUILD, [21, 1, 8]),
    ).toEqual([]);
  });
});

describe("artifact descriptor", () => {
  it("describes all archive artifacts and skips checksum files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "llvm-dist-test-"));
    try {
      await writeFile(
        path.join(tempDir, "llvm-dist-llvm-core-llvmorg-21.1.8-release-linux-x64.tar.xz"),
        "core",
      );
      await writeFile(
        path.join(tempDir, "llvm-dist-llvm-core-llvmorg-21.1.8-release-linux-x64.tar.xz.sha256"),
        "ignored",
      );
      await mkdir(path.join(tempDir, "nested"));
      await writeFile(
        path.join(
          tempDir,
          "nested",
          "llvm-dist-pdb-llvmorg-21.1.8-relwithdebinfo-windows-x64.tar.xz",
        ),
        "pdb",
      );
      await writeFile(path.join(tempDir, "descriptor.json"), "{}");

      const descriptor = await createArtifactDescriptor(tempDir, {
        packagePrefix: "llvm-dist",
        generatedAt: "2026-05-30T00:00:00.000Z",
      });

      expect(descriptor).toMatchObject({
        schemaVersion: 1,
        generatedAt: "2026-05-30T00:00:00.000Z",
        packagePrefix: "llvm-dist",
        artifactCount: 2,
      });
      expect(descriptor.artifacts.map((artifact) => artifact.path)).toEqual([
        "llvm-dist-llvm-core-llvmorg-21.1.8-release-linux-x64.tar.xz",
        "nested/llvm-dist-pdb-llvmorg-21.1.8-relwithdebinfo-windows-x64.tar.xz",
      ]);
      expect(descriptor.artifacts[0]).toMatchObject({
        package: "llvm-core",
        type: "component-package",
        llvmTag: "llvmorg-21.1.8",
        buildType: "release",
        platform: "linux-x64",
        targetTriple: "x86_64-unknown-linux-gnu",
        dependsOn: [],
      });
      expect(descriptor.artifacts[0]?.components).toContain("LLVMSupport");
      expect(descriptor.artifacts[1]).toMatchObject({
        package: "pdb",
        type: "debug-symbols",
        llvmTag: "llvmorg-21.1.8",
        buildType: "relwithdebinfo",
        platform: "windows-x64",
        targetTriple: "x86_64-pc-windows-msvc",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("build type mapping", () => {
  it("keeps the legacy Release and RelWithDebInfo mapping", () => {
    expect(BUILD_TYPE_TO_CMAKE).toEqual({
      release: "Release",
      relwithdebinfo: "RelWithDebInfo",
    });
  });
});
