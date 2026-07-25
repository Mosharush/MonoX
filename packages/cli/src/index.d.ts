import type { Cloudapter, MonoXPlan, MonoXReceipt } from '@monox/cloudapter-core';

export interface CliIo {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  readFile?: typeof import('node:fs/promises').readFile;
  writeFile?: typeof import('node:fs/promises').writeFile;
  mkdir?: typeof import('node:fs/promises').mkdir;
  mkdtemp?: typeof import('node:fs/promises').mkdtemp;
  rename?: typeof import('node:fs/promises').rename;
  rm?: typeof import('node:fs/promises').rm;
}

export interface LocalComposeExecutor {
  doctor(input?: { composeFiles?: string[]; projectName?: string }): Promise<Record<string, unknown>>;
  execute(action: Record<string, unknown>, options: { plan: MonoXPlan }): Promise<Record<string, unknown>>;
  status(input: {
    workloads?: Array<Record<string, unknown>>;
    target?: Record<string, unknown>;
    composeFiles?: string[];
    projectName?: string;
    ownedServices?: string[];
  }): Promise<Record<string, unknown>>;
  rollback(input: {
    plan: MonoXPlan;
    ownedOnly: true;
    [key: string]: unknown;
  }): Promise<Record<string, unknown>>;
  destroy(input: {
    plan: MonoXPlan;
    ownedOnly: true;
    [key: string]: unknown;
  }): Promise<Record<string, unknown>>;
}

export interface LocalComposeDependencies {
  spawn?: typeof import('node:child_process').spawn;
  fetch?: (input: string, init?: Record<string, unknown>) => Promise<{ status: number }>;
  connect?: typeof import('node:net').createConnection;
  sleep?(milliseconds: number): Promise<void>;
  clock?(): number;
  probeHttp?(input: {
    workload: string;
    port: number;
    path: string;
    timeoutMs: number;
  }): boolean | Promise<boolean>;
  probeTcp?(input: { workload: string; port: number; timeoutMs: number }): boolean | Promise<boolean>;
  env?: Record<string, string | undefined>;
}

export interface CliOptions {
  adapters?: Map<string, Cloudapter> | Record<string, Cloudapter>;
  resolveAdapter?(target: Record<string, unknown>): Cloudapter | Promise<Cloudapter | undefined> | undefined;
  resolveAffected?(input: { root: string; base?: string; head?: string }): string[] | Promise<string[]>;
  local?: LocalComposeExecutor;
  localComposeDependencies?: LocalComposeDependencies;
  createLocalComposeExecutor?(options: { projectRoot: string; [key: string]: unknown }): LocalComposeExecutor;
}

export interface MigrationReport {
  schemaVersion: '1';
  kind: 'MonoXMigrationReport';
  sourceFormat: 'monox-v1' | 'legacy-production';
  targetVersion: '2';
  inputSummary: { keys: string[] };
  changes: Array<Record<string, unknown>>;
  warnings: string[];
  manualReview: Array<{ path: string; reason: string; code: string }>;
  output: Record<string, unknown>;
}

export declare function usage(): string;
export declare function parseArguments(argv: string[]): {
  positional: string[];
  flags: Record<string, string | true>;
};
export declare function run(
  argv: string[],
  io?: CliIo,
  options?: CliOptions
): Promise<Record<string, unknown>>;
export declare function migrateV1Deployment(
  input: Record<string, unknown>,
  options?: Record<string, unknown>
): MigrationReport;
export declare function migrateLegacyDeployment(
  input: Record<string, unknown>,
  options?: Record<string, unknown>
): MigrationReport;
export declare function migrateDeployment(
  input: Record<string, unknown>,
  options: { from: 'monox-v1' | 'legacy-production'; [key: string]: unknown }
): MigrationReport;
export declare function createLocalComposeExecutor(
  options: LocalComposeDependencies & { projectRoot: string }
): LocalComposeExecutor;

export type { Cloudapter, MonoXPlan, MonoXReceipt };
