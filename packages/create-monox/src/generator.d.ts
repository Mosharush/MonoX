import type {
  AddonRecipeId,
  DeliveryTarget,
  DeliveryTargetId,
  RecipeIntegrity,
  WorkspaceRecipeId,
} from './catalog.js';

export type {
  AddonInstallStatus,
  AddonRecipe,
  AddonRecipeCategory,
  AddonRecipeId,
  AvailableDeliveryTargetId,
  CatalogEntry,
  CatalogManifest,
  DeliveryProvider,
  DeliveryProvisioner,
  DeliveryRuntime,
  DeliveryTarget,
  DeliveryTargetId,
  DeliveryTransport,
  ExternalRecipeReference,
  NamespacedRecipeId,
  PlannedDeliveryTargetId,
  RecipeApiVersion,
  RecipeIntegrity,
  RecipeReference,
  WorkspaceRecipe,
  WorkspaceRecipeFamily,
  WorkspaceRecipeId,
  WorkspaceRecipeKind,
  WorkspaceRecipeLanguage,
} from './catalog.js';

export type PackageManager = 'yarn' | 'npm' | 'pnpm';
export type InfrastructureOption = 'none' | 'docker' | 'kubernetes' | 'all';
export type MonoXEnvironment = 'development' | 'preview' | 'staging' | 'production';

export interface WorkspaceSelection {
  readonly name: string;
  readonly template: WorkspaceRecipeId;
}

export interface GeneratorOptions {
  name: string;
  cwd?: string;
  directory?: string;
  packageManager?: PackageManager;
  infra?: InfrastructureOption;
  environment?: MonoXEnvironment;
  delivery?: DeliveryTargetId;
  workspaces?: readonly (string | WorkspaceSelection)[] | Readonly<Record<string, WorkspaceRecipeId>>;
  addons?: readonly AddonRecipeId[];
  git?: boolean;
  install?: boolean;
  dryRun?: boolean;
}

export interface NormalizedGeneratorOptions {
  readonly name: string;
  readonly cwd: string;
  readonly directory?: string;
  readonly packageManager: PackageManager;
  readonly infra: InfrastructureOption;
  readonly environment: MonoXEnvironment;
  readonly delivery: DeliveryTargetId;
  readonly deliveryDefinition: DeliveryTarget;
  readonly workspaces: readonly WorkspaceSelection[];
  readonly addons: readonly AddonRecipeId[];
  readonly git: boolean;
  readonly install: boolean;
  readonly dryRun: boolean;
}

export interface GenerationResult {
  readonly name: string;
  readonly directory: string;
  readonly packageManager: PackageManager;
  readonly infra: InfrastructureOption;
  readonly environment: MonoXEnvironment;
  readonly delivery: DeliveryTargetId;
  readonly workspaces: readonly WorkspaceSelection[];
  readonly addons: readonly AddonRecipeId[];
  readonly files: readonly string[];
  readonly fileDigests: Readonly<Record<string, RecipeIntegrity>>;
  readonly dryRun: boolean;
  readonly gitInitialized: boolean;
  readonly installed: boolean;
}

export interface CommandOptions {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions
) => Promise<void>;

export interface GenerateProjectDependencies {
  runCommand?: CommandRunner;
}

export interface PackageManagerInvocation {
  readonly command: 'npx';
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export declare const GENERATOR_VERSION: '0.2.0';
export declare const PACKAGE_MANAGERS: readonly PackageManager[];
export declare const INFRA_OPTIONS: readonly InfrastructureOption[];
export declare const ENVIRONMENTS: readonly MonoXEnvironment[];
export declare const COREPACK_VERSION: '0.35.0';
export declare const NODE_VERSION_RANGE: string;
export declare const PACKAGE_MANAGER_VERSIONS: Readonly<Record<PackageManager, string>>;
export declare const DEFAULT_WORKSPACES: readonly WorkspaceSelection[];

export declare function validateProjectName(name: string): string;
export declare function resolveDestination(options?: {
  cwd?: string;
  name?: string;
  directory?: string;
}): string;
export declare function parseWorkspaceSelection(value: string): Readonly<WorkspaceSelection>;
export declare const runCommand: CommandRunner;
export declare function generateProject(
  options: GeneratorOptions,
  dependencies?: GenerateProjectDependencies
): Promise<Readonly<GenerationResult>>;
export declare function createGenerationPlan(options: GeneratorOptions): Readonly<GenerationResult>;
export declare function packageManagerInvocation(
  packageManager: PackageManager,
  args?: readonly string[]
): PackageManagerInvocation;
export declare function packageManagerShellCommand(
  packageManager: PackageManager,
  args?: readonly string[]
): string;
export declare function normalizeOptions(options?: GeneratorOptions): Readonly<NormalizedGeneratorOptions>;
