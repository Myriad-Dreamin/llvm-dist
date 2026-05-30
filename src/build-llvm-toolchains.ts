#!/usr/bin/env -S node --import tsx

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export type VersionTuple = readonly [major: number, minor: number, patch: number];
export type BuildType = "release" | "relwithdebinfo";
export type PackageProfileName =
  | "llvm-core"
  | "clang-sdk"
  | "clang-tooling"
  | "clang-tidy"
  | "clang-repl";

export interface PackageProfile {
  readonly name: PackageProfileName;
  readonly components: readonly string[];
  readonly dependsOn: readonly PackageProfileName[];
}

export interface ArtifactDescriptorEntry {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly package?: PackageProfileName | "pdb" | undefined;
  readonly type?: "component-package" | "debug-symbols" | undefined;
  readonly llvmTag?: string | undefined;
  readonly buildType?: BuildType | undefined;
  readonly platform?: string | undefined;
  readonly dependsOn?: readonly PackageProfileName[] | undefined;
  readonly components?: readonly string[] | undefined;
}

export interface ArtifactDescriptor {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly packagePrefix: string;
  readonly artifactCount: number;
  readonly artifacts: readonly ArtifactDescriptorEntry[];
}

export interface ParsedVersionTag {
  readonly prefix: string;
  readonly version: VersionTuple;
  readonly suffix: string;
  readonly raw: string;
}

export interface ExistingWorktreeMatch {
  readonly buildSuffix: string;
  readonly tagSuffix: string;
}

export interface BuildTask {
  readonly kind: "auto" | "manual";
  readonly version?: VersionTuple;
  readonly suffix: string;
  readonly llvmTag: string;
  readonly worktree: string;
  readonly buildTypes: readonly BuildType[];
  readonly matchedWorktree?: ExistingWorktreeMatch | undefined;
}

export interface BuildPlan {
  readonly tasks: readonly BuildTask[];
  readonly discoveredTags: readonly ParsedVersionTag[];
  readonly discoveredWorktrees: readonly ParsedVersionTag[];
}

export interface ManualTarget {
  readonly worktree: string;
  readonly llvmTag: string;
}

export interface CreateBuildPlanOptions {
  readonly worktreeEntries: readonly string[];
  readonly llvmTags: readonly string[];
  readonly allowList?: readonly VersionTuple[];
  readonly manualList?: readonly ManualTarget[];
  readonly buildTypes?: readonly BuildType[];
  readonly minMajor?: number;
}

interface CliOptions {
  readonly action: string;
  readonly llvmDir: string;
  readonly scriptsDir: string;
  readonly allowList: readonly VersionTuple[];
  readonly manualList: readonly ManualTarget[];
  readonly buildTypes: readonly BuildType[];
  readonly minMajor: number;
  readonly ccache: boolean;
  readonly ccacheProgram: string;
  readonly ccacheDir: string;
  readonly ccacheBaseDir: string;
  readonly ccacheMaxSize: string;
  readonly jobs: number;
  readonly dryRun: boolean;
  readonly artifactDir: string;
  readonly packagePrefix: string;
  readonly packageProfiles: readonly PackageProfileName[];
  readonly platform: string;
  readonly descriptorName: string;
}

const RELEASE_SUFFIX_MARKER = "-rcN";

export const DEFAULT_ALLOW_LIST = [
  [15, 0, 7],
  [21, 1, 8],
] as const satisfies readonly VersionTuple[];

export const DEFAULT_BUILD_TYPES = [
  "release",
  "relwithdebinfo",
] as const satisfies readonly BuildType[];

export const BUILD_TYPE_TO_CMAKE = {
  release: "Release",
  relwithdebinfo: "RelWithDebInfo",
} as const satisfies Record<BuildType, string>;

export const LLVM_PACKAGE_PROFILES = [
  {
    name: "llvm-core",
    dependsOn: [],
    components: [
      "llvm-headers",
      "LLVMSupport",
      "LLVMFrontendOpenMP",
      "LLVMOption",
      "LLVMTargetParser",
    ],
  },
  {
    name: "clang-sdk",
    dependsOn: ["llvm-core"],
    components: [
      "clang-headers",
      "clang-resource-headers",
      "clangAnalysis",
      "clangAST",
      "clangASTMatchers",
      "clangBasic",
      "clangDriver",
      "clangEdit",
      "clangFrontend",
      "clangIndex",
      "clangLex",
      "clangParse",
      "clangSema",
      "clangSerialization",
    ],
  },
  {
    name: "clang-tooling",
    dependsOn: ["llvm-core", "clang-sdk"],
    components: [
      "clangFormat",
      "clangTooling",
      "clangToolingCore",
      "clangToolingInclusions",
      "clangToolingInclusionsStdlib",
      "clangToolingRefactoring",
      "clangToolingSyntax",
    ],
  },
  {
    name: "clang-tidy",
    dependsOn: ["llvm-core", "clang-sdk", "clang-tooling"],
    components: [
      "clangTidy",
      "clangTidyAbseilModule",
      "clangTidyAlteraModule",
      "clangTidyAndroidModule",
      "clangTidyBoostModule",
      "clangTidyBugproneModule",
      "clangTidyCERTModule",
      "clangTidyConcurrencyModule",
      "clangTidyCppCoreGuidelinesModule",
      "clangTidyDarwinModule",
      "clangTidyFuchsiaModule",
      "clangTidyGoogleModule",
      "clangTidyHICPPModule",
      "clangTidyLinuxKernelModule",
      "clangTidyLLVMModule",
      "clangTidyLLVMLibcModule",
      "clangTidyMiscModule",
      "clangTidyModernizeModule",
      "clangTidyObjCModule",
      "clangTidyOpenMPModule",
      "clangTidyPerformanceModule",
      "clangTidyPortabilityModule",
      "clangTidyReadabilityModule",
      "clangTidyUtils",
      "clangTidyZirconModule",
    ],
  },
  {
    name: "clang-repl",
    dependsOn: ["llvm-core", "clang-sdk"],
    components: ["clang-repl"],
  },
] as const satisfies readonly PackageProfile[];

export const DEFAULT_PACKAGE_PROFILES = LLVM_PACKAGE_PROFILES.map((profile) => profile.name);

export const CLICE_LLVM_COMPONENTS = uniqueStrings(
  LLVM_PACKAGE_PROFILES.filter((profile) => profile.name !== "clang-repl").flatMap(
    (profile) => profile.components,
  ),
);

export const EXTRA_LLVM_COMPONENTS = ["clang-repl"] as const;

export const LLVM_DISTRIBUTION_COMPONENTS = uniqueStrings([
  ...CLICE_LLVM_COMPONENTS,
  ...EXTRA_LLVM_COMPONENTS,
]);

const PACKAGE_PROFILE_BY_NAME = new Map(
  LLVM_PACKAGE_PROFILES.map((profile) => [profile.name, profile]),
);

const DESCRIPTOR_ARTIFACT_EXTENSIONS = [".tar.xz", ".tar.gz", ".tgz", ".tar.zst", ".zip"] as const;

export function parseVersionTag(prefix: string, value: string): ParsedVersionTag | undefined {
  const regexp = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)\\.(\\d+)\\.(\\d+)(-[A-Za-z0-9_]+)?$`);
  const match = regexp.exec(value);
  if (!match) {
    return undefined;
  }

  const major = Number.parseInt(requiredMatch(match, 1), 10);
  const minor = Number.parseInt(requiredMatch(match, 2), 10);
  const patch = Number.parseInt(requiredMatch(match, 3), 10);
  return {
    prefix,
    version: [major, minor, patch],
    suffix: match[4] ?? RELEASE_SUFFIX_MARKER,
    raw: value,
  };
}

export function createBuildPlan(options: CreateBuildPlanOptions): BuildPlan {
  const buildTypes = options.buildTypes ?? DEFAULT_BUILD_TYPES;
  const minMajor = options.minMajor ?? 10;
  const allowSet = new Set((options.allowList ?? DEFAULT_ALLOW_LIST).map(versionKey));

  const discoveredWorktrees = options.worktreeEntries
    .map((entry) => parseVersionTag("build", entry))
    .filter(isDefined);

  const discoveredTags = options.llvmTags
    .map((tag) => parseVersionTag("llvmorg", tag))
    .filter(isDefined)
    .filter((tag) => tag.version[0] >= minMajor);

  const latestTags = latestByVersion(discoveredTags);
  const worktreesByVersion = latestByVersion(discoveredWorktrees);
  const majorGroups = groupByMajor([...latestTags.values()]);
  const tasks: BuildTask[] = [];

  while (majorGroups.some((group) => group.length > 0)) {
    for (const group of majorGroups) {
      const latest = group.shift();
      if (!latest || !allowSet.has(versionKey(latest.version))) {
        continue;
      }

      const matchedWorktree = worktreesByVersion.get(versionKey(latest.version));
      const suffix = tagSuffixToPathSuffix(latest.suffix);
      tasks.push({
        kind: "auto",
        version: latest.version,
        suffix,
        llvmTag: `llvmorg-${versionToString(latest.version)}${suffix}`,
        worktree: `build-${versionToString(latest.version)}${suffix}`,
        buildTypes,
        matchedWorktree: matchedWorktree
          ? {
              buildSuffix: matchedWorktree.suffix,
              tagSuffix: latest.suffix,
            }
          : undefined,
      });
    }
  }

  for (const manualTarget of options.manualList ?? []) {
    tasks.push({
      kind: "manual",
      suffix: manualTarget.llvmTag,
      llvmTag: manualTarget.llvmTag,
      worktree: manualTarget.worktree,
      buildTypes,
    });
  }

  return {
    tasks,
    discoveredTags,
    discoveredWorktrees,
  };
}

export function versionToString(version: VersionTuple): string {
  return version.join(".");
}

export function versionKey(version: VersionTuple): string {
  return versionToString(version);
}

export function tagSuffixToPathSuffix(suffix: string): string {
  return suffix === RELEASE_SUFFIX_MARKER ? "" : suffix;
}

export function buildCMakeDistributionComponents(): string {
  return LLVM_DISTRIBUTION_COMPONENTS.join(";");
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));

  if (options.action === "help") {
    printHelp();
    return;
  }

  if (options.action === "components") {
    console.log(buildCMakeDistributionComponents());
    return;
  }

  if (options.action === "profiles") {
    console.log(JSON.stringify(LLVM_PACKAGE_PROFILES, null, 2));
    return;
  }

  if (options.action === "descriptor") {
    const descriptor = await writeArtifactDescriptor(options);
    console.log(
      `wrote ${descriptor.artifactCount} artifact entries to ${path.join(
        options.artifactDir,
        options.descriptorName,
      )}`,
    );
    return;
  }

  const plan = await loadBuildPlan(options);
  if (options.action === "plan") {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  await runBuildPlan(plan, options);
}

async function loadBuildPlan(options: CliOptions): Promise<BuildPlan> {
  const [worktreeEntries, llvmTagsOutput] = await Promise.all([
    fs.readdir(options.llvmDir),
    captureCommand("git", ["tag"], { cwd: options.llvmDir }),
  ]);

  return createBuildPlan({
    worktreeEntries,
    llvmTags: llvmTagsOutput.split(/\r?\n/).filter(Boolean),
    allowList: options.allowList,
    manualList: options.manualList,
    buildTypes: options.buildTypes,
    minMajor: options.minMajor,
  });
}

async function runBuildPlan(plan: BuildPlan, options: CliOptions): Promise<void> {
  if (options.action === "package") {
    await runPackagePlan(plan, options);
    return;
  }

  await setupCcache(options);

  for (const task of plan.tasks) {
    if (
      task.kind === "auto" &&
      task.matchedWorktree &&
      task.matchedWorktree.buildSuffix !== task.matchedWorktree.tagSuffix
    ) {
      console.warn(
        [
          "warning upgrade your workdir manually:",
          `${task.worktree}${tagSuffixToPathSuffix(task.matchedWorktree.buildSuffix)}`,
          "=>",
          `${task.worktree}${tagSuffixToPathSuffix(task.matchedWorktree.tagSuffix)}`,
        ].join(" "),
      );
    }

    await ensureWorktree(task, options);
    for (const buildType of task.buildTypes) {
      await runTaskScript(task, buildType, options);
    }
  }
}

async function runPackagePlan(plan: BuildPlan, options: CliOptions): Promise<void> {
  for (const task of plan.tasks) {
    await ensureWorktree(task, options);
    for (const buildType of task.buildTypes) {
      await packageBuild(task, buildType, options);
    }
  }
}

async function packageBuild(
  task: BuildTask,
  buildType: BuildType,
  options: CliOptions,
): Promise<void> {
  const buildDir = path.join(
    options.llvmDir,
    task.worktree,
    "build",
    BUILD_TYPE_TO_CMAKE[buildType],
  );
  const stagingRoot = path.join(buildDir, ".llvm-dist-packages");
  const pdbStagingDir = path.join(stagingRoot, "pdb");
  const selectedProfiles = options.packageProfiles.map(requiredPackageProfile);

  await assertFileReadable(path.join(buildDir, "CMakeCache.txt"));
  await fs.mkdir(options.artifactDir, { recursive: true });
  await fs.rm(stagingRoot, { recursive: true, force: true });
  await fs.mkdir(pdbStagingDir, { recursive: true });

  console.log(
    [
      "===========",
      "package",
      task.llvmTag,
      buildType,
      task.worktree,
      "=====================",
    ].join(" "),
  );

  for (const profile of selectedProfiles) {
    const profileStagingDir = path.join(stagingRoot, profile.name);
    await fs.mkdir(profileStagingDir, { recursive: true });

    for (const component of profile.components) {
      await runCommand(
        "cmake",
        ["--install", ".", "--component", component, "--prefix", profileStagingDir],
        {
          cwd: buildDir,
          dryRun: options.dryRun,
          env: buildTaskEnv(task, buildType, options),
        },
      );
    }

    await movePdbFiles(profileStagingDir, pdbStagingDir);
    await createPackageArchive(profileStagingDir, profile.name, task, buildType, options);
  }

  if (await hasAnyFile(pdbStagingDir)) {
    await createPackageArchive(pdbStagingDir, "pdb", task, buildType, options);
  } else {
    console.log(`skip pdb package for ${task.llvmTag} ${buildType}: no .pdb files`);
  }
}

async function createPackageArchive(
  stagingDir: string,
  packageName: PackageProfileName | "pdb",
  task: BuildTask,
  buildType: BuildType,
  options: CliOptions,
): Promise<void> {
  if (options.dryRun) {
    console.log(`[dry-run] package ${packageName} from ${stagingDir}`);
    return;
  }

  if (!(await hasAnyFile(stagingDir))) {
    throw new Error(`package ${packageName} did not install any files: ${stagingDir}`);
  }

  const archivePath = path.join(
    options.artifactDir,
    `${options.packagePrefix}-${packageName}-${task.llvmTag}-${buildType}-${options.platform}.tar.xz`,
  );

  await fs.rm(archivePath, { force: true });
  await runCommand("tar", ["-C", stagingDir, "-cJf", archivePath, "."], {
    dryRun: options.dryRun,
  });
  await writeSha256File(archivePath);
}

export async function createArtifactDescriptor(
  artifactDir: string,
  options: {
    readonly packagePrefix: string;
    readonly descriptorName?: string;
    readonly generatedAt?: string;
  },
): Promise<ArtifactDescriptor> {
  const descriptorName = options.descriptorName ?? "descriptor.json";
  const artifactPaths = (await walkFiles(artifactDir)).filter((artifactPath) =>
    shouldIncludeInDescriptor(artifactPath, descriptorName),
  );

  const artifacts = await Promise.all(
    artifactPaths.map(async (artifactPath): Promise<ArtifactDescriptorEntry> => {
      const [stats, sha256] = await Promise.all([fs.stat(artifactPath), sha256File(artifactPath)]);
      return {
        ...inferArtifactMetadata(path.basename(artifactPath), options.packagePrefix),
        name: path.basename(artifactPath),
        path: toPosixPath(path.relative(artifactDir, artifactPath)),
        size: stats.size,
        sha256,
      };
    }),
  );

  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    packagePrefix: options.packagePrefix,
    artifactCount: artifacts.length,
    artifacts,
  };
}

async function writeArtifactDescriptor(options: CliOptions): Promise<ArtifactDescriptor> {
  await fs.mkdir(options.artifactDir, { recursive: true });

  const artifactPaths = (await walkFiles(options.artifactDir)).filter((artifactPath) =>
    shouldIncludeInDescriptor(artifactPath, options.descriptorName),
  );
  if (artifactPaths.length === 0) {
    throw new Error(`no artifacts found in ${options.artifactDir}`);
  }

  for (const artifactPath of artifactPaths) {
    await writeSha256File(artifactPath);
  }

  const descriptor = await createArtifactDescriptor(options.artifactDir, {
    packagePrefix: options.packagePrefix,
    descriptorName: options.descriptorName,
  });
  const descriptorPath = path.join(options.artifactDir, options.descriptorName);
  await fs.writeFile(`${descriptorPath}.tmp`, `${JSON.stringify(descriptor, null, 2)}\n`);
  await fs.rename(`${descriptorPath}.tmp`, descriptorPath);
  await writeSha256File(descriptorPath);
  return descriptor;
}

async function ensureWorktree(task: BuildTask, options: CliOptions): Promise<void> {
  const worktreePath = path.join(options.llvmDir, task.worktree);
  if (await exists(worktreePath)) {
    return;
  }

  await runCommand("git", ["worktree", "add", task.worktree, task.llvmTag], {
    cwd: options.llvmDir,
    dryRun: options.dryRun,
  });
}

async function runTaskScript(
  task: BuildTask,
  buildType: BuildType,
  options: CliOptions,
): Promise<void> {
  const buildDir = path.join(
    options.llvmDir,
    task.worktree,
    "build",
    BUILD_TYPE_TO_CMAKE[buildType],
  );
  const scriptName = `${options.action}.sh`;
  const buildTypeScript = path.join(options.scriptsDir, `${options.action}-${buildType}.sh`);
  const defaultScript = path.join(options.scriptsDir, scriptName);
  const sourceScript = (await exists(buildTypeScript)) ? buildTypeScript : defaultScript;

  await assertFileReadable(sourceScript);
  await fs.mkdir(buildDir, { recursive: true });

  const destinationScript = path.join(buildDir, scriptName);
  await fs.rm(destinationScript, { force: true });
  await fs.copyFile(sourceScript, destinationScript);
  await fs.chmod(destinationScript, 0o755);

  console.log(
    [
      "===========",
      "progress",
      task.llvmTag,
      buildType,
      task.worktree,
      "=====================",
    ].join(" "),
  );

  await runCommand("bash", [destinationScript], {
    cwd: buildDir,
    dryRun: options.dryRun,
    env: buildTaskEnv(task, buildType, options),
  });

  console.log(
    [
      "===========",
      "done    ",
      task.llvmTag,
      buildType,
      task.worktree,
      "=====================",
    ].join(" "),
  );
}

function buildTaskEnv(
  task: BuildTask,
  buildType: BuildType,
  options: CliOptions,
): NodeJS.ProcessEnv {
  return compactEnv({
    ...process.env,
    CCACHE_BASEDIR: options.ccacheBaseDir,
    CCACHE_DIR: options.ccacheDir,
    SCRIPT_ARTIFACT_DIR: options.artifactDir,
    SCRIPT_BUILD_JOBS: String(options.jobs),
    SCRIPT_CCACHE_BASEDIR: options.ccacheBaseDir,
    SCRIPT_CCACHE_DIR: options.ccacheDir,
    SCRIPT_CCACHE_MAX_SIZE: options.ccacheMaxSize,
    SCRIPT_CCACHE_PROGRAM: options.ccacheProgram,
    SCRIPT_CMAKE_BUILD_TYPE: BUILD_TYPE_TO_CMAKE[buildType],
    SCRIPT_ENABLE_CCACHE: options.ccache ? "1" : "0",
    SCRIPT_LLVM_DISTRIBUTION_COMPONENTS: buildCMakeDistributionComponents(),
    SCRIPT_LLVM_TAG: task.llvmTag,
    SCRIPT_PACKAGE_PLATFORM: options.platform,
    SCRIPT_PACKAGE_PREFIX: options.packagePrefix,
    SCRIPT_STD_BUILD_TYPE: buildType,
    SCRIPT_WORKTREE: task.worktree,
  });
}

async function setupCcache(options: CliOptions): Promise<void> {
  if (!options.ccache || options.action === "package") {
    return;
  }

  await fs.mkdir(options.ccacheDir, { recursive: true });
  await runCommand(options.ccacheProgram, ["--set-config", `max_size=${options.ccacheMaxSize}`], {
    dryRun: options.dryRun,
  });
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  const args = [...argv];
  const action = args.shift() ?? "help";

  const allowList: VersionTuple[] = [];
  const manualList: ManualTarget[] = [];
  let llvmDir = "llvm-mainline";
  let scriptsDir = "scripts";
  let buildTypes: readonly BuildType[] = DEFAULT_BUILD_TYPES;
  let minMajor = 10;
  let ccache = true;
  let ccacheProgram = "ccache";
  let ccacheDir = path.resolve(".cache", "ccache");
  let ccacheBaseDir = process.cwd();
  let ccacheMaxSize = "10G";
  let jobs = Math.max(1, os.cpus().length);
  let dryRun = false;
  let artifactDir = path.resolve("artifacts");
  let packagePrefix = "llvm-dist";
  let packageProfiles: readonly PackageProfileName[] = DEFAULT_PACKAGE_PROFILES;
  let platform = `${process.platform}-${process.arch}`;
  let descriptorName = "descriptor.json";

  for (let index = 0; index < args.length; index += 1) {
    const arg = requiredArg(args, index);
    switch (arg) {
      case "--llvm-dir":
        llvmDir = takeValue(args, ++index, arg);
        break;
      case "--scripts-dir":
        scriptsDir = takeValue(args, ++index, arg);
        break;
      case "--allow":
        allowList.push(...parseVersionList(takeValue(args, ++index, arg)));
        break;
      case "--manual":
        manualList.push(parseManualTarget(takeValue(args, ++index, arg)));
        break;
      case "--build-types":
        buildTypes = parseBuildTypes(takeValue(args, ++index, arg));
        break;
      case "--min-major":
        minMajor = parsePositiveInt(takeValue(args, ++index, arg), arg);
        break;
      case "--ccache":
        ccache = true;
        break;
      case "--no-ccache":
        ccache = false;
        break;
      case "--ccache-program":
        ccacheProgram = takeValue(args, ++index, arg);
        break;
      case "--ccache-dir":
        ccacheDir = path.resolve(takeValue(args, ++index, arg));
        break;
      case "--ccache-base-dir":
        ccacheBaseDir = path.resolve(takeValue(args, ++index, arg));
        break;
      case "--ccache-max-size":
        ccacheMaxSize = takeValue(args, ++index, arg);
        break;
      case "--jobs":
        jobs = parsePositiveInt(takeValue(args, ++index, arg), arg);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--artifact-dir":
        artifactDir = path.resolve(takeValue(args, ++index, arg));
        break;
      case "--package-prefix":
        packagePrefix = takeValue(args, ++index, arg);
        break;
      case "--package-profiles":
        packageProfiles = parsePackageProfiles(takeValue(args, ++index, arg));
        break;
      case "--platform":
        platform = takeValue(args, ++index, arg);
        break;
      case "--descriptor-name":
        descriptorName = takeValue(args, ++index, arg);
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  return {
    action,
    llvmDir: path.resolve(llvmDir),
    scriptsDir: path.resolve(scriptsDir),
    allowList: allowList.length > 0 ? allowList : DEFAULT_ALLOW_LIST,
    manualList,
    buildTypes,
    minMajor,
    ccache,
    ccacheProgram,
    ccacheDir,
    ccacheBaseDir,
    ccacheMaxSize,
    jobs,
    dryRun,
    artifactDir,
    packagePrefix,
    packageProfiles,
    platform,
    descriptorName,
  };
}

function parseBuildTypes(value: string): readonly BuildType[] {
  return splitCommaList(value).map((item) => {
    const normalized = item.toLowerCase();
    if (normalized === "release") {
      return "release";
    }
    if (normalized === "relwithdebinfo" || normalized === "rel-with-deb-info") {
      return "relwithdebinfo";
    }
    throw new Error(`unsupported build type: ${item}`);
  });
}

function parsePackageProfiles(value: string): readonly PackageProfileName[] {
  return splitCommaList(value).map((name) => requiredPackageProfile(name).name);
}

function requiredPackageProfile(name: string): PackageProfile {
  const profile = PACKAGE_PROFILE_BY_NAME.get(name as PackageProfileName);
  if (!profile) {
    throw new Error(`unsupported package profile: ${name}`);
  }
  return profile;
}

function parseVersionList(value: string): VersionTuple[] {
  return splitCommaList(value).map(parseVersionTuple);
}

function parseVersionTuple(value: string): VersionTuple {
  const parts = value.split(".");
  if (parts.length !== 3) {
    throw new Error(`expected version x.y.z, got: ${value}`);
  }
  return [
    parsePositiveInt(requiredArrayItem(parts, 0), "version major"),
    parsePositiveInt(requiredArrayItem(parts, 1), "version minor"),
    parsePositiveInt(requiredArrayItem(parts, 2), "version patch"),
  ];
}

function parseManualTarget(value: string): ManualTarget {
  const [worktree, llvmTag] = value.split(":");
  if (!worktree) {
    throw new Error(`invalid manual target: ${value}`);
  }
  return { worktree, llvmTag: llvmTag ?? worktree };
}

function latestByVersion(tags: readonly ParsedVersionTag[]): Map<string, ParsedVersionTag> {
  const latest = new Map<string, ParsedVersionTag>();
  for (const tag of tags) {
    const key = versionKey(tag.version);
    const existing = latest.get(key);
    if (!existing || compareParsedTag(tag, existing) > 0) {
      latest.set(key, tag);
    }
  }
  return latest;
}

function groupByMajor(tags: readonly ParsedVersionTag[]): ParsedVersionTag[][] {
  const groups = new Map<number, ParsedVersionTag[]>();
  for (const tag of tags) {
    const major = tag.version[0];
    groups.set(major, [...(groups.get(major) ?? []), tag]);
  }
  return [...groups.entries()]
    .sort(([leftMajor], [rightMajor]) => rightMajor - leftMajor)
    .map(([, group]) => group.sort((left, right) => compareParsedTag(right, left)));
}

function compareParsedTag(left: ParsedVersionTag, right: ParsedVersionTag): number {
  const versionComparison = compareVersion(left.version, right.version);
  if (versionComparison !== 0) {
    return versionComparison;
  }
  return compareSuffix(left.suffix, right.suffix);
}

function compareVersion(left: VersionTuple, right: VersionTuple): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = requiredArrayItem(left, index) - requiredArrayItem(right, index);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function compareSuffix(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left === RELEASE_SUFFIX_MARKER) {
    return 1;
  }
  if (right === RELEASE_SUFFIX_MARKER) {
    return -1;
  }
  return left.localeCompare(right);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`expected positive integer for ${label}, got: ${value}`);
  }
  return parsed;
}

async function movePdbFiles(sourceRoot: string, pdbRoot: string): Promise<void> {
  const pdbFiles = (await walkFiles(sourceRoot)).filter((filePath) =>
    filePath.toLowerCase().endsWith(".pdb"),
  );

  for (const pdbFile of pdbFiles) {
    const relativePath = path.relative(sourceRoot, pdbFile);
    const destination = path.join(pdbRoot, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });

    if (await exists(destination)) {
      const [sourceHash, destinationHash] = await Promise.all([
        sha256File(pdbFile),
        sha256File(destination),
      ]);
      if (sourceHash !== destinationHash) {
        throw new Error(`conflicting pdb artifact path: ${relativePath}`);
      }
      await fs.rm(pdbFile);
      continue;
    }

    await fs.rename(pdbFile, destination);
  }
}

async function hasAnyFile(root: string): Promise<boolean> {
  for (const filePath of await walkFiles(root)) {
    const stat = await fs.lstat(filePath);
    if (stat.isFile() || stat.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

async function walkFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(entryPath);
    }
  }
  return files;
}

function shouldIncludeInDescriptor(artifactPath: string, descriptorName: string): boolean {
  const basename = path.basename(artifactPath);
  return (
    basename !== descriptorName &&
    basename !== `${descriptorName}.sha256` &&
    !basename.endsWith(".sha256") &&
    DESCRIPTOR_ARTIFACT_EXTENSIONS.some((extension) => basename.endsWith(extension))
  );
}

function inferArtifactMetadata(
  fileName: string,
  packagePrefix: string,
): Omit<ArtifactDescriptorEntry, "name" | "path" | "size" | "sha256"> {
  const archiveSuffix = DESCRIPTOR_ARTIFACT_EXTENSIONS.find((extension) =>
    fileName.endsWith(extension),
  );
  if (!archiveSuffix) {
    return {};
  }

  const baseName = fileName.slice(0, -archiveSuffix.length);
  for (const packageName of [...DEFAULT_PACKAGE_PROFILES, "pdb"] as const) {
    const prefix = `${packagePrefix}-${packageName}-`;
    if (!baseName.startsWith(prefix)) {
      continue;
    }

    const rest = baseName.slice(prefix.length);
    const match = /^(.*)-(release|relwithdebinfo)-(.+)$/.exec(rest);
    if (!match) {
      continue;
    }

    const llvmTag = requiredMatch(match, 1);
    const buildType = requiredMatch(match, 2) as BuildType;
    const platform = requiredMatch(match, 3);
    if (packageName === "pdb") {
      return {
        package: "pdb",
        type: "debug-symbols",
        llvmTag,
        buildType,
        platform,
      };
    }

    const profile = requiredPackageProfile(packageName);
    return {
      package: profile.name,
      type: "component-package",
      llvmTag,
      buildType,
      platform,
      dependsOn: profile.dependsOn,
      components: profile.components,
    };
  }

  return {};
}

async function writeSha256File(filePath: string): Promise<string> {
  const hash = await sha256File(filePath);
  await fs.writeFile(`${filePath}.sha256`, `${hash}  ${path.basename(filePath)}\n`);
  return hash;
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fsSync.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

async function captureCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string } = {},
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${code}\n${Buffer.concat(
            stderr,
          ).toString("utf8")}`,
        ),
      );
    });
  });
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly dryRun?: boolean;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<void> {
  const rendered = [command, ...args].join(" ");
  if (options.dryRun) {
    console.log(`[dry-run] ${options.cwd ? `(${options.cwd}) ` : ""}${rendered}`);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${rendered} failed with exit code ${code}`));
      }
    });
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function assertFileReadable(target: string): Promise<void> {
  try {
    await fs.access(target, fsConstants.R_OK);
  } catch {
    throw new Error(`script is not readable: ${target}`);
  }
}

function compactEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

function requiredArg(args: readonly string[], index: number): string {
  return requiredArrayItem(args, index);
}

function takeValue(args: readonly string[], index: number, optionName: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${optionName}`);
  }
  return value;
}

function requiredMatch(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`missing regexp capture ${index}`);
  }
  return value;
}

function requiredArrayItem<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`missing array item ${index}`);
  }
  return value;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printHelp(): void {
  console.log(`Usage:
  pnpm llvm <action> [options]

Actions:
  plan          Print the discovered LLVM worktree plan as JSON.
  components    Print LLVM_DISTRIBUTION_COMPONENTS.
  profiles      Print package profile definitions.
  descriptor    Generate descriptor.json and .sha256 files for artifacts.
  init          Configure each selected build directory.
  build         Run ninja for each selected build directory.
  install       Build install-distribution for each selected build directory.
  package       Package selected component profiles into artifacts/.

Options:
  --llvm-dir <path>             LLVM git checkout containing tags/worktrees.
  --scripts-dir <path>          Directory containing action scripts.
  --allow <x.y.z[,x.y.z]>       LLVM versions to build.
  --manual <worktree[:tag]>     Add a downstream/manual worktree target.
  --build-types <list>          release,relwithdebinfo.
  --min-major <number>          Ignore llvmorg tags older than this major.
  --ccache | --no-ccache        Enable or disable ccache setup.
  --ccache-dir <path>           ccache directory.
  --ccache-max-size <size>      ccache max size, for example 10G.
  --jobs <number>               Ninja jobs exported to action scripts.
  --artifact-dir <path>         Package output directory.
  --package-prefix <name>       Package filename prefix.
  --package-profiles <list>     Package profiles: llvm-core,clang-sdk,clang-tooling,clang-tidy,clang-repl.
  --platform <name>             Package filename platform segment.
  --descriptor-name <name>      Descriptor filename.
  --dry-run                     Print commands without executing them.
`);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
