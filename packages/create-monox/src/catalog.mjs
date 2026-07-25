import { createHash } from 'node:crypto';

export const CATALOG_VERSION = '2026.1';
export const RECIPE_API_VERSION = '1';
export const RECIPE_VERSION = '1.0.0';

const recipe = (definition) =>
  Object.freeze({ apiVersion: RECIPE_API_VERSION, version: RECIPE_VERSION, ...definition });

export const WORKSPACE_RECIPES = Object.freeze({
  'node-http-api': recipe({
    family: 'javascript',
    language: 'javascript',
    framework: 'node-http',
    kind: 'service',
    port: 3001,
  }),
  'node-fastify-api': recipe({
    family: 'javascript',
    language: 'javascript',
    framework: 'fastify',
    kind: 'service',
    port: 3001,
  }),
  'node-express-api': recipe({
    family: 'javascript',
    language: 'javascript',
    framework: 'express',
    kind: 'service',
    port: 3001,
  }),
  'node-nest-api': recipe({
    family: 'javascript',
    language: 'typescript',
    framework: 'nestjs',
    kind: 'service',
    port: 3001,
  }),
  'node-hono-api': recipe({
    family: 'javascript',
    language: 'javascript',
    framework: 'hono',
    kind: 'service',
    port: 3001,
  }),
  'node-worker': recipe({ family: 'javascript', language: 'javascript', framework: 'node', kind: 'worker' }),
  'node-cron': recipe({
    family: 'javascript',
    language: 'javascript',
    framework: 'node',
    kind: 'cron',
    schedule: '0 * * * *',
  }),
  'react-vite-web': recipe({
    version: '1.1.0',
    family: 'javascript',
    language: 'javascript',
    framework: 'react-vite',
    kind: 'static',
    port: 4173,
  }),
  'vue-vite-web': recipe({
    version: '1.1.0',
    family: 'javascript',
    language: 'javascript',
    framework: 'vue-vite',
    kind: 'static',
    port: 4173,
  }),
  'next-web': recipe({
    family: 'javascript',
    language: 'javascript',
    framework: 'next',
    kind: 'service',
    port: 3000,
  }),
  'nuxt-web': recipe({
    family: 'javascript',
    language: 'typescript',
    framework: 'nuxt',
    kind: 'service',
    port: 3000,
  }),
  'sveltekit-web': recipe({
    family: 'javascript',
    language: 'javascript',
    framework: 'sveltekit',
    kind: 'service',
    port: 3000,
  }),
  'angular-web': recipe({
    version: '1.1.0',
    family: 'javascript',
    language: 'typescript',
    framework: 'angular',
    kind: 'static',
    port: 4200,
  }),
  'typescript-library': recipe({
    family: 'javascript',
    language: 'typescript',
    framework: 'typescript',
    kind: 'library',
  }),
  'python-fastapi-api': recipe({
    family: 'python',
    language: 'python',
    framework: 'fastapi',
    kind: 'service',
    port: 8000,
  }),
  'python-django-api': recipe({
    family: 'python',
    language: 'python',
    framework: 'django',
    kind: 'service',
    port: 8000,
  }),
  'python-worker': recipe({ family: 'python', language: 'python', framework: 'python', kind: 'worker' }),
  'python-model': recipe({
    family: 'python',
    language: 'python',
    framework: 'fastapi',
    kind: 'model',
    port: 8000,
  }),
  'python-library': recipe({ family: 'python', language: 'python', framework: 'python', kind: 'library' }),
  'php-laravel-api': recipe({
    version: '1.1.0',
    family: 'php',
    language: 'php',
    framework: 'laravel',
    kind: 'service',
    port: 8080,
  }),
  'php-library': recipe({ family: 'php', language: 'php', framework: 'composer', kind: 'library' }),
  'go-chi-api': recipe({ family: 'go', language: 'go', framework: 'chi', kind: 'service', port: 8080 }),
  'go-worker': recipe({ family: 'go', language: 'go', framework: 'go', kind: 'worker' }),
  'go-library': recipe({ family: 'go', language: 'go', framework: 'go', kind: 'library' }),
});

const addon = (definition) =>
  Object.freeze({
    apiVersion: RECIPE_API_VERSION,
    version: RECIPE_VERSION,
    production: true,
    ...definition,
  });
const kubernetesAddon = (definition = {}) =>
  addon({
    category: 'kubernetes',
    kubernetes: true,
    install: {
      status: 'unverified',
      reason: 'OCI chart coordinates and digests must be verified before apply.',
    },
    ...definition,
  });

export const ADDON_RECIPES = Object.freeze({
  postgresql: addon({ category: 'data', compose: true }),
  mongodb: addon({ category: 'data', compose: true }),
  redis: addon({ category: 'data', compose: true }),
  rabbitmq: addon({ category: 'messaging', compose: true }),
  nats: addon({ category: 'messaging', compose: true }),
  redpanda: addon({ category: 'messaging', compose: true }),
  temporal: addon({ category: 'messaging', compose: true }),
  localstack: addon({ category: 'messaging', compose: true, production: false }),
  ollama: addon({ category: 'ai', compose: true }),
  qdrant: addon({ category: 'search', compose: true }),
  typesense: addon({ category: 'search', compose: true }),
  opensearch: addon({ category: 'search', compose: true }),
  minio: addon({ category: 'storage', compose: true }),
  keycloak: addon({ category: 'identity', compose: true }),
  flipt: addon({ category: 'development', compose: true }),
  mailpit: addon({ category: 'development', compose: true, production: false }),
  'otel-collector': addon({ category: 'observability', compose: true }),
  prometheus: addon({ category: 'observability', compose: true }),
  grafana: addon({ category: 'observability', compose: true }),
  loki: addon({ category: 'observability', compose: true }),
  tempo: addon({ category: 'observability', compose: true }),
  'cert-manager': kubernetesAddon(),
  'external-secrets': kubernetesAddon(),
  keda: kubernetesAddon(),
  'metrics-server': kubernetesAddon(),
  gateway: kubernetesAddon(),
  'kube-prometheus-stack': kubernetesAddon(),
  'nvidia-gpu-operator': kubernetesAddon(),
});

export const DELIVERY_TARGETS = Object.freeze({
  'docker:local': Object.freeze({
    provider: 'generic',
    provisioner: 'none',
    transport: 'local',
    runtime: 'docker',
  }),
  'pm2:generic-ssh': Object.freeze({
    provider: 'generic',
    provisioner: 'none',
    transport: 'ssh',
    runtime: 'pm2',
  }),
  'docker:generic-ssh': Object.freeze({
    provider: 'generic',
    provisioner: 'none',
    transport: 'ssh',
    runtime: 'docker',
  }),
  'pm2:aws-ec2': Object.freeze({
    provider: 'aws',
    provisioner: 'pulumi',
    transport: 'aws-ssm',
    runtime: 'pm2',
  }),
  'docker:aws-ec2': Object.freeze({
    provider: 'aws',
    provisioner: 'pulumi',
    transport: 'aws-ssm',
    runtime: 'docker',
  }),
  'pm2:gcp-compute': Object.freeze({
    provider: 'gcp',
    provisioner: 'pulumi',
    transport: 'gcp-iap',
    runtime: 'pm2',
  }),
  'docker:gcp-compute': Object.freeze({
    provider: 'gcp',
    provisioner: 'pulumi',
    transport: 'gcp-iap',
    runtime: 'docker',
  }),
  'coolify:existing-coolify': Object.freeze({
    provider: 'generic',
    provisioner: 'none',
    transport: 'coolify-api',
    runtime: 'coolify',
  }),
  'coolify:aws-coolify': Object.freeze({
    provider: 'aws',
    provisioner: 'pulumi',
    transport: 'coolify-api',
    runtime: 'coolify',
  }),
  'coolify:gcp-coolify': Object.freeze({
    provider: 'gcp',
    provisioner: 'pulumi',
    transport: 'coolify-api',
    runtime: 'coolify',
  }),
  'kubernetes:existing-kubernetes': Object.freeze({
    provider: 'generic',
    provisioner: 'none',
    transport: 'kubernetes-api',
    runtime: 'kubernetes',
  }),
  'kubernetes:aws-eks': Object.freeze({
    provider: 'aws',
    provisioner: 'pulumi',
    transport: 'kubernetes-api',
    runtime: 'kubernetes',
  }),
  'kubernetes:gcp-gke': Object.freeze({
    provider: 'gcp',
    provisioner: 'pulumi',
    transport: 'kubernetes-api',
    runtime: 'kubernetes',
  }),
  'static:aws-s3-cloudfront': Object.freeze({
    provider: 'aws',
    provisioner: 'pulumi',
    transport: 'local',
    runtime: 'static',
  }),
  'static:gcp-gcs-cdn': Object.freeze({
    provider: 'gcp',
    provisioner: 'pulumi',
    transport: 'local',
    runtime: 'static',
  }),
});

export const WORKSPACE_TEMPLATE_IDS = Object.freeze(Object.keys(WORKSPACE_RECIPES));
export const ADDON_IDS = Object.freeze(Object.keys(ADDON_RECIPES));
export const DELIVERY_IDS = Object.freeze(Object.keys(DELIVERY_TARGETS));
export const PLANNED_DELIVERY_IDS = Object.freeze([
  'docker:generic-ssh',
  'docker:aws-ec2',
  'docker:gcp-compute',
]);
export const AVAILABLE_DELIVERY_IDS = Object.freeze(
  DELIVERY_IDS.filter((id) => !PLANNED_DELIVERY_IDS.includes(id))
);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function integrityFor(value) {
  return `sha256-${createHash('sha256').update(canonicalJson(value)).digest('base64')}`;
}

export function catalogManifest() {
  const workspaces = Object.fromEntries(
    Object.entries(WORKSPACE_RECIPES).map(([id, definition]) => [
      id,
      {
        apiVersion: definition.apiVersion,
        version: definition.version,
        integrity: integrityFor({ id, ...definition }),
      },
    ])
  );
  const addons = Object.fromEntries(
    Object.entries(ADDON_RECIPES).map(([id, definition]) => [
      id,
      {
        apiVersion: definition.apiVersion,
        version: definition.version,
        integrity: integrityFor({ id, ...definition }),
      },
    ])
  );

  return Object.freeze({
    version: CATALOG_VERSION,
    integrity: integrityFor({ version: CATALOG_VERSION, workspaces, addons, delivery: DELIVERY_TARGETS }),
    workspaces,
    addons,
  });
}

export function assertWorkspaceTemplate(id) {
  const definition = WORKSPACE_RECIPES[id];
  if (!definition)
    throw new Error(`Workspace template must be one of: ${WORKSPACE_TEMPLATE_IDS.join(', ')}.`);
  return definition;
}

export function assertAddon(id) {
  const definition = ADDON_RECIPES[id];
  if (!definition) throw new Error(`Add-on must be one of: ${ADDON_IDS.join(', ')}.`);
  return definition;
}

export function assertDelivery(id) {
  const definition = DELIVERY_TARGETS[id];
  if (!definition) throw new Error(`Delivery must be one of: ${DELIVERY_IDS.join(', ')}.`);
  return definition;
}
