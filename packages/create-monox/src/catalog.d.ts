export type RecipeApiVersion = '1';
export type RecipeIntegrity = `sha256-${string}`;
export type NamespacedRecipeId = `@${string}/${string}`;

export interface RecipeReference<Id extends string = string> {
  readonly id: Id;
  readonly apiVersion: RecipeApiVersion;
  readonly version: string;
  readonly integrity: RecipeIntegrity;
}

export interface ExternalRecipeReference extends RecipeReference<NamespacedRecipeId> {}

export type WorkspaceRecipeFamily = 'javascript' | 'python' | 'php' | 'go';
export type WorkspaceRecipeLanguage = 'javascript' | 'typescript' | 'python' | 'php' | 'go';
export type WorkspaceRecipeKind = 'service' | 'worker' | 'cron' | 'model' | 'static' | 'library';

export interface WorkspaceRecipe {
  readonly apiVersion: RecipeApiVersion;
  readonly version: string;
  readonly family: WorkspaceRecipeFamily;
  readonly language: WorkspaceRecipeLanguage;
  readonly framework: string;
  readonly kind: WorkspaceRecipeKind;
  readonly port?: number;
  readonly schedule?: string;
}

export type AddonRecipeCategory =
  | 'data'
  | 'messaging'
  | 'ai'
  | 'search'
  | 'storage'
  | 'identity'
  | 'development'
  | 'observability'
  | 'kubernetes';

export interface AddonInstallStatus {
  readonly status: 'verified' | 'unverified';
  readonly reason?: string;
}

export interface AddonRecipe {
  readonly apiVersion: RecipeApiVersion;
  readonly version: string;
  readonly category: AddonRecipeCategory;
  readonly production: boolean;
  readonly compose?: true;
  readonly kubernetes?: true;
  readonly install?: AddonInstallStatus;
}

export type DeliveryProvider = 'generic' | 'aws' | 'gcp';
export type DeliveryProvisioner = 'none' | 'pulumi';
export type DeliveryTransport = 'local' | 'ssh' | 'aws-ssm' | 'gcp-iap' | 'coolify-api' | 'kubernetes-api';
export type DeliveryRuntime = 'pm2' | 'docker' | 'coolify' | 'kubernetes' | 'static';

export interface DeliveryTarget {
  readonly provider: DeliveryProvider;
  readonly provisioner: DeliveryProvisioner;
  readonly transport: DeliveryTransport;
  readonly runtime: DeliveryRuntime;
}

export type WorkspaceRecipeId =
  | 'node-http-api'
  | 'node-fastify-api'
  | 'node-express-api'
  | 'node-nest-api'
  | 'node-hono-api'
  | 'node-worker'
  | 'node-cron'
  | 'react-vite-web'
  | 'vue-vite-web'
  | 'next-web'
  | 'nuxt-web'
  | 'sveltekit-web'
  | 'angular-web'
  | 'typescript-library'
  | 'python-fastapi-api'
  | 'python-django-api'
  | 'python-worker'
  | 'python-model'
  | 'python-library'
  | 'php-laravel-api'
  | 'php-library'
  | 'go-chi-api'
  | 'go-worker'
  | 'go-library';

export type AddonRecipeId =
  | 'postgresql'
  | 'mongodb'
  | 'redis'
  | 'rabbitmq'
  | 'nats'
  | 'redpanda'
  | 'temporal'
  | 'localstack'
  | 'ollama'
  | 'qdrant'
  | 'typesense'
  | 'opensearch'
  | 'minio'
  | 'keycloak'
  | 'flipt'
  | 'mailpit'
  | 'otel-collector'
  | 'prometheus'
  | 'grafana'
  | 'loki'
  | 'tempo'
  | 'cert-manager'
  | 'external-secrets'
  | 'keda'
  | 'metrics-server'
  | 'gateway'
  | 'kube-prometheus-stack'
  | 'nvidia-gpu-operator';

export type DeliveryTargetId =
  | 'docker:local'
  | 'pm2:generic-ssh'
  | 'docker:generic-ssh'
  | 'pm2:aws-ec2'
  | 'docker:aws-ec2'
  | 'pm2:gcp-compute'
  | 'docker:gcp-compute'
  | 'coolify:existing-coolify'
  | 'coolify:aws-coolify'
  | 'coolify:gcp-coolify'
  | 'kubernetes:existing-kubernetes'
  | 'kubernetes:aws-eks'
  | 'kubernetes:gcp-gke'
  | 'static:aws-s3-cloudfront'
  | 'static:gcp-gcs-cdn';

export type PlannedDeliveryTargetId = 'docker:generic-ssh' | 'docker:aws-ec2' | 'docker:gcp-compute';
export type AvailableDeliveryTargetId = Exclude<DeliveryTargetId, PlannedDeliveryTargetId>;

export interface CatalogEntry {
  readonly apiVersion: RecipeApiVersion;
  readonly version: string;
  readonly integrity: RecipeIntegrity;
}

export interface CatalogManifest {
  readonly version: string;
  readonly integrity: RecipeIntegrity;
  readonly workspaces: Readonly<Record<WorkspaceRecipeId, CatalogEntry>>;
  readonly addons: Readonly<Record<AddonRecipeId, CatalogEntry>>;
}

export declare const CATALOG_VERSION: '2026.1';
export declare const RECIPE_API_VERSION: RecipeApiVersion;
export declare const RECIPE_VERSION: '1.0.0';
export declare const WORKSPACE_RECIPES: Readonly<Record<WorkspaceRecipeId, WorkspaceRecipe>>;
export declare const ADDON_RECIPES: Readonly<Record<AddonRecipeId, AddonRecipe>>;
export declare const DELIVERY_TARGETS: Readonly<Record<DeliveryTargetId, DeliveryTarget>>;
export declare const WORKSPACE_TEMPLATE_IDS: readonly WorkspaceRecipeId[];
export declare const ADDON_IDS: readonly AddonRecipeId[];
export declare const DELIVERY_IDS: readonly DeliveryTargetId[];
export declare const PLANNED_DELIVERY_IDS: readonly PlannedDeliveryTargetId[];
export declare const AVAILABLE_DELIVERY_IDS: readonly AvailableDeliveryTargetId[];

export declare function canonicalJson(value: unknown): string;
export declare function integrityFor(value: unknown): RecipeIntegrity;
export declare function catalogManifest(): Readonly<CatalogManifest>;
export declare function assertWorkspaceTemplate(id: string): WorkspaceRecipe;
export declare function assertAddon(id: string): AddonRecipe;
export declare function assertDelivery(id: string): DeliveryTarget;
