export {
  type MonoXConfigRequiredFields,
  type TargetProvider,
  type TargetProvisioner,
  type TargetRuntime,
  type TargetTransport,
} from './generated.js';

import type { DeploymentPatchV2, DeploymentSpecV2, ValidationIssue } from '@monox/deploy-schema';
import type { TargetProvider, TargetProvisioner, TargetRuntime, TargetTransport } from './generated.js';

export interface MonoXProjectConfig {
  name: string;
  workspaceGlobs: string[];
  defaultEnvironment?: string;
}

export interface WorkloadSelector {
  workloads?: string[];
  kinds?: string[];
  profiles?: string[];
  locations?: string[];
  variants?: string[];
}

export interface EnvironmentConfig {
  production?: boolean;
  protected?: boolean;
  bindings: Array<{ target: string; selector: WorkloadSelector }>;
}

export interface TargetBindings {
  namespace?: string;
  registry?: string;
  domain?: string;
  identityRef?: string;
  secretStoreRef?: string;
}

export interface TargetConfig {
  provider: TargetProvider;
  provisioner: TargetProvisioner;
  transport: TargetTransport;
  runtime: TargetRuntime;
  bindings?: TargetBindings;
  region?: string;
  projectRef?: string;
  serverRef?: string;
  clusterRef?: string;
  ttlHours?: number;
}

export interface AddonConfig {
  recipe: string;
  enabled: boolean;
  mode: 'bundled' | 'managed' | 'external';
  environments?: string[];
  config?: Record<string, string>;
  secretRefs?: string[];
}

export interface MonoXConfigV2 {
  $schema?: string;
  schemaVersion: '2';
  project: MonoXProjectConfig;
  boundaries: Record<string, string[]>;
  workloadProfiles: Record<string, DeploymentPatchV2>;
  environments: Record<string, EnvironmentConfig>;
  targets: Record<string, TargetConfig>;
  addons: Record<string, AddonConfig>;
}

export interface WorkspaceSummary {
  name: string;
  location: string;
}

export interface ResolvedWorkload {
  workspace: WorkspaceSummary;
  environment: string;
  variant: string | null;
  profile: string | null;
  deployment: DeploymentSpecV2;
  target: TargetConfig & { id: string };
}

export declare const MONOX_CONFIG_SCHEMA_VERSION: '2';
export declare const monoxTargetAxes: Readonly<Record<string, readonly string[]>>;
export declare class MonoXConfigValidationError extends TypeError {
  errors: ValidationIssue[];
}
export declare class TargetBindingError extends TypeError {
  workload: string;
  environment: string;
  matches: string[];
}
export declare function validateMonoXConfigV2(input: unknown): {
  valid: boolean;
  errors: ValidationIssue[];
  value: MonoXConfigV2;
};
export declare function assertValidMonoXConfigV2(input: unknown): MonoXConfigV2;
export declare function applyMergePatch<T>(target: T, patch: unknown): T;
export declare function resolveDeploymentSpecV2(
  rawDeployment: DeploymentSpecV2,
  config: MonoXConfigV2,
  environment: string,
  variant?: string | null
): DeploymentSpecV2;
export declare function matchingTargetIds(
  config: MonoXConfigV2,
  environment: string,
  workload: Omit<ResolvedWorkload, 'target'>
): string[];
export declare function bindTarget(
  config: MonoXConfigV2,
  environment: string,
  workload: Omit<ResolvedWorkload, 'target'>
): TargetConfig & { id: string };
export declare function discoverDeploymentWorkspaces(root?: string): Promise<{
  root: string;
  deployments: Array<{
    workspace: WorkspaceSummary & { directory: string; manifest: Record<string, unknown> };
    rawDeployment: DeploymentSpecV2;
  }>;
}>;
export declare function loadMonoXConfig(root?: string): Promise<{
  root: string;
  file: string;
  config: MonoXConfigV2;
}>;
export declare function resolveProjectDeployments(options?: {
  root?: string;
  environment?: string;
  targetId?: string;
}): Promise<{
  root: string;
  file: string;
  config: MonoXConfigV2;
  environment: string;
  workloads: ResolvedWorkload[];
}>;
