export * from './generated.js';

import type { DeploymentPatchV2, DeploymentSpecV2 } from './generated.js';

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

export interface ValidationResult<T> {
  valid: boolean;
  errors: ValidationIssue[];
  value: T;
}

export declare const DEPLOYMENT_SCHEMA_VERSION: '1';
export declare function isSecretReferenceKey(key: unknown): boolean;
export declare function isSecretLikeKey(key: unknown): boolean;
export declare function containsSecretMaterial(value: unknown): boolean;
export declare const deploymentSchema: Record<string, unknown>;
export declare class DeploymentValidationError extends TypeError {
  errors: ValidationIssue[];
}
export declare function normalizeDeploymentConfig(input: unknown): Record<string, unknown>;
export declare function validateDeploymentConfig(input: unknown): ValidationResult<Record<string, unknown>>;
export declare function assertValidDeploymentConfig(input: unknown): Record<string, unknown>;

export declare const DEPLOYMENT_SCHEMA_VERSION_V2: '2';
export declare const deploymentSchemaV2: Record<string, unknown>;
export declare const deploymentV2Enums: Readonly<Record<string, readonly string[]>>;
export declare const deploymentV2AllowedProperties: Readonly<Record<string, readonly string[]>>;
export declare class DeploymentV2ValidationError extends TypeError {
  errors: ValidationIssue[];
}
export declare function normalizeDeploymentSpecV2(input: DeploymentSpecV2): DeploymentSpecV2;
export declare function validateDeploymentSpecV2(
  input: unknown,
  options?: { normalize?: boolean }
): ValidationResult<DeploymentSpecV2>;
export declare function assertValidDeploymentSpecV2(
  input: unknown,
  options?: { normalize?: boolean }
): DeploymentSpecV2;
export declare function validateDeploymentPatchV2(input: unknown): ValidationResult<DeploymentPatchV2>;
export declare function assertValidDeploymentPatchV2(input: unknown): DeploymentPatchV2;
