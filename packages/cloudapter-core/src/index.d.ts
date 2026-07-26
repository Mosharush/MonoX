export interface CloudapterTarget {
  id: string;
  provider: string;
  provisioner: string;
  transport: string;
  runtime: string;
  [key: string]: unknown;
}

export interface CloudapterWorkload {
  workspace: { name: string; location: string };
  environment: string;
  variant: string | null;
  profile: string | null;
  deployment: { id: string; [key: string]: unknown };
  target: CloudapterTarget;
}

export interface CloudapterDescriptor {
  id: string;
  version: string;
  apiVersion: string;
  capabilities: string[];
  digest: string;
}

export interface CloudapterContext {
  projectRoot: string;
  config: Record<string, unknown>;
  environment: string;
  target: CloudapterTarget;
  workloads: CloudapterWorkload[];
  sourceDigest: string;
  targetStateDigest: string;
  scope?: 'delivery' | 'cloud';
  [transport: string]: unknown;
}

export interface MonoXPlan {
  schemaVersion: '1';
  kind: 'MonoXPlan';
  id: string;
  createdAt: string;
  adapter: CloudapterDescriptor;
  project: Record<string, unknown>;
  environment: string;
  target: CloudapterTarget;
  workloads: CloudapterWorkload[];
  actions: Array<Record<string, unknown>>;
  sourceDigest: string;
  targetStateDigest: string;
  metadata: Record<string, unknown>;
  digest: string;
}

export interface MonoXReceipt {
  schemaVersion: '1';
  kind: 'MonoXReceipt';
  id: string;
  createdAt: string;
  planDigest: string;
  adapter: CloudapterDescriptor;
  project: Record<string, unknown>;
  environment: string;
  target: CloudapterTarget;
  operation: string;
  result: Record<string, unknown>;
  digest: string;
}

export interface Cloudapter {
  id: string;
  version: string;
  apiVersion?: string;
  capabilities?: string[];
  doctor(context: CloudapterContext): Promise<Record<string, unknown>>;
  validate(context: CloudapterContext): Promise<{
    valid: boolean;
    errors: unknown[];
    warnings?: unknown[];
  }>;
  plan(context: CloudapterContext): Promise<MonoXPlan>;
  render(plan: MonoXPlan, context: CloudapterContext): Promise<Record<string, unknown>>;
  apply(plan: MonoXPlan, context: CloudapterContext): Promise<MonoXReceipt>;
  status(context: CloudapterContext): Promise<Record<string, unknown>>;
  rollback(request: Record<string, unknown>, context: CloudapterContext): Promise<MonoXReceipt>;
  destroy(request: Record<string, unknown>, context: CloudapterContext): Promise<MonoXReceipt>;
}

export declare const CLOUDAPTER_API_VERSION: '1';
export declare const PLAN_SCHEMA_VERSION: '1';
export declare const RECEIPT_SCHEMA_VERSION: '1';
export declare function canonicalize(value: unknown): string;
export declare function deterministicDigest(value: unknown): string;
export declare function redactSecrets<T>(value: T): T;
export declare function deepFreeze<T>(value: T): Readonly<T>;
export declare function assertCloudapter<T extends Cloudapter>(adapter: T): T;
export declare function createPlan(input: {
  adapter: Cloudapter;
  project?: Record<string, unknown>;
  environment: string;
  target: CloudapterTarget;
  workloads?: CloudapterWorkload[];
  actions?: Array<Record<string, unknown>>;
  sourceDigest: string;
  targetStateDigest: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}): Readonly<MonoXPlan>;
export declare class StalePlanError extends Error {
  reasons: string[];
}
export declare function assertFreshPlan(
  plan: MonoXPlan,
  current: {
    adapter: Cloudapter;
    sourceDigest: string;
    targetStateDigest: string;
  }
): MonoXPlan;
export declare function createReceipt(input: {
  plan: MonoXPlan;
  operation?: string;
  result?: Record<string, unknown>;
  createdAt?: string;
}): Readonly<MonoXReceipt>;

export declare class NoopCloudapter implements Cloudapter {
  constructor(options?: { id?: string; version?: string; reason?: string });
  id: string;
  version: string;
  apiVersion: string;
  capabilities: string[];
  reason: string;
  doctor(context: CloudapterContext): Promise<Record<string, unknown>>;
  validate(context: CloudapterContext): Promise<{ valid: true; errors: []; warnings: string[] }>;
  plan(context: CloudapterContext): Promise<MonoXPlan>;
  render(plan: MonoXPlan, context: CloudapterContext): Promise<Record<string, unknown>>;
  apply(plan: MonoXPlan, context: CloudapterContext): Promise<MonoXReceipt>;
  status(context: CloudapterContext): Promise<Record<string, unknown>>;
  rollback(request: Record<string, unknown>, context: CloudapterContext): Promise<MonoXReceipt>;
  destroy(request: Record<string, unknown>, context: CloudapterContext): Promise<MonoXReceipt>;
}

export declare class PlanOnlyCloudapter implements Cloudapter {
  constructor(options: {
    id: string;
    version: string;
    capabilities?: string[];
    executor?: Record<string, (...args: unknown[]) => unknown>;
  });
  id: string;
  version: string;
  apiVersion: string;
  capabilities: string[];
  executor?: Record<string, (...args: unknown[]) => unknown>;
  doctor(context: CloudapterContext): Promise<Record<string, unknown>>;
  validate(context: CloudapterContext): Promise<{
    valid: true;
    errors: [];
    warnings: string[];
  }>;
  plan(context: CloudapterContext): Promise<MonoXPlan>;
  render(plan: MonoXPlan, context: CloudapterContext): Promise<Record<string, unknown>>;
  apply(plan: MonoXPlan, context: CloudapterContext): Promise<MonoXReceipt>;
  status(context: CloudapterContext): Promise<Record<string, unknown>>;
  rollback(request: Record<string, unknown>, context: CloudapterContext): Promise<MonoXReceipt>;
  destroy(request: Record<string, unknown>, context: CloudapterContext): Promise<MonoXReceipt>;
}

export declare function createNoopCloudapter(options?: {
  id?: string;
  version?: string;
  reason?: string;
}): NoopCloudapter;
