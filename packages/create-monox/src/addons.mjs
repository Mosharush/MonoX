import { ADDON_RECIPES, assertAddon } from './catalog.mjs';

const composeServices = Object.freeze({
  postgresql: `  postgresql:
    image: postgres:18.1-alpine@sha256:aa6eb304ddb6dd26df23d05db4e5cb05af8951cda3e0dc57731b771e0ef4ab29
    environment:
      POSTGRES_DB: \${POSTGRES_DB:?Set POSTGRES_DB}
      POSTGRES_USER: \${POSTGRES_USER:?Set POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}
    ports: ["127.0.0.1:5432:5432"]
    volumes: [postgresql-data:/var/lib/postgresql/data]
    healthcheck:
      test: [CMD-SHELL, "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 10s
      timeout: 5s
      retries: 10
    security_opt: [no-new-privileges:true]
`,
  mongodb: `  mongodb:
    image: mongo:8.2.1-noble@sha256:6c7e2053173654448af4158109b3dc66c319d7a3c5753e95ab04a3e97cf9311c
    environment:
      MONGO_INITDB_ROOT_USERNAME: \${MONGODB_ROOT_USERNAME:?Set MONGODB_ROOT_USERNAME}
      MONGO_INITDB_ROOT_PASSWORD: \${MONGODB_ROOT_PASSWORD:?Set MONGODB_ROOT_PASSWORD}
    ports: ["127.0.0.1:27017:27017"]
    volumes: [mongodb-data:/data/db]
    healthcheck:
      test: [CMD-SHELL, "mongosh --quiet --eval 'db.adminCommand({ ping: 1 })' || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10
    security_opt: [no-new-privileges:true]
`,
  redis: `  redis:
    image: redis:8.4.0-alpine@sha256:4eec4565e45aa0b3966554c866bc73211e281b0b3d89fe9a33c982e6faca809d
    entrypoint: [/bin/sh, /opt/monox/redis-start.sh]
    ports: ["127.0.0.1:6379:6379"]
    volumes: [../docker/redis-start.sh:/opt/monox/redis-start.sh:ro, ../docker/redis-healthcheck.sh:/opt/monox/redis-healthcheck.sh:ro, ../docker/validate-secret.sh:/opt/monox/validate-secret.sh:ro, redis-data:/data]
    secrets: [redis_password]
    healthcheck:
      test: [CMD, /bin/sh, /opt/monox/redis-healthcheck.sh]
      interval: 10s
      timeout: 5s
      retries: 10
    read_only: true
    tmpfs: [/tmp]
    security_opt: [no-new-privileges:true]
`,
  rabbitmq: `  rabbitmq:
    image: rabbitmq:4.2.1-management-alpine@sha256:f1f1ec0bb9b5cb55335a433c00e2f4804bdf90f513e53260ce47b82d2165de24
    environment:
      RABBITMQ_DEFAULT_USER: \${RABBITMQ_USERNAME:?Set RABBITMQ_USERNAME}
      RABBITMQ_DEFAULT_PASS: \${RABBITMQ_PASSWORD:?Set RABBITMQ_PASSWORD}
    ports: ["127.0.0.1:5672:5672", "127.0.0.1:15672:15672"]
    volumes: [rabbitmq-data:/var/lib/rabbitmq]
    healthcheck:
      test: [CMD, rabbitmq-diagnostics, -q, ping]
      interval: 10s
      timeout: 5s
      retries: 12
    security_opt: [no-new-privileges:true]
`,
  nats: `  nats:
    image: nats:2.12.2-alpine@sha256:2d5fce3229ae5741f4ef9225aff95dc4dc036455931eaf77a3eec33fddaa192d
    entrypoint: [/bin/sh, /opt/monox/nats-start.sh]
    ports: ["127.0.0.1:4222:4222"]
    volumes: [../docker/nats-start.sh:/opt/monox/nats-start.sh:ro, ../docker/validate-secret.sh:/opt/monox/validate-secret.sh:ro, nats-data:/data]
    secrets: [nats_token]
    read_only: true
    tmpfs: [/tmp]
    security_opt: [no-new-privileges:true]
`,
  redpanda: `  redpanda:
    image: docker.redpanda.com/redpandadata/redpanda:v25.3.3@sha256:c94a5ec70ad0f9ea61b444660b5f7177cbfe299894da0e41e00e0c0a6351a7fe
    command: [redpanda, start, --mode, dev-container, --smp, "1", --memory, 1G, --reserve-memory, 0M, --node-id, "0", --check=false]
    ports: ["127.0.0.1:19092:9092"]
    volumes: [redpanda-data:/var/lib/redpanda/data]
    healthcheck:
      test: [CMD-SHELL, "rpk cluster health | grep -q 'Healthy: true'"]
      interval: 10s
      timeout: 5s
      retries: 12
    security_opt: [no-new-privileges:true]
`,
  temporal: `  temporal:
    image: temporalio/auto-setup:1.29.1@sha256:5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312
    environment:
      DB: postgres12
      DB_PORT: "5432"
      POSTGRES_SEEDS: postgresql
      POSTGRES_USER: \${POSTGRES_USER:?Set POSTGRES_USER}
      POSTGRES_PWD: \${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}
      DBNAME: \${POSTGRES_DB:?Set POSTGRES_DB}
      VISIBILITY_DBNAME: \${TEMPORAL_VISIBILITY_DB:-temporal_visibility}
    ports: ["127.0.0.1:7233:7233"]
    depends_on:
      postgresql:
        condition: service_healthy
    security_opt: [no-new-privileges:true]
`,
  localstack: `  localstack:
    image: localstack/localstack:4.9.2@sha256:59373b4a27dba3ec15c4db0b7455f0cb68c8a42300e2cbbe362b440f9a131697
    environment:
      SERVICES: \${LOCALSTACK_SERVICES:-sqs,s3}
      PERSISTENCE: "1"
    ports: ["127.0.0.1:4566:4566"]
    volumes: [localstack-data:/var/lib/localstack]
    security_opt: [no-new-privileges:true]
`,
  ollama: `  ollama:
    image: ollama/ollama:0.13.5@sha256:2c9595c555fd70a28363489ac03bd5bf9e7c5bdf2890373c3a830ffd7252ce6d
    ports: ["127.0.0.1:11434:11434"]
    volumes: [ollama-data:/root/.ollama]
    security_opt: [no-new-privileges:true]
`,
  qdrant: `  qdrant:
    image: qdrant/qdrant:v1.15.4@sha256:6ac4807063bbecddca0250bfbcff52acf18c22263b904d12919349e6d0a408f1
    environment:
      QDRANT__SERVICE__API_KEY: \${QDRANT_API_KEY:?Set QDRANT_API_KEY}
    ports: ["127.0.0.1:6333:6333"]
    volumes: [qdrant-data:/qdrant/storage]
    security_opt: [no-new-privileges:true]
`,
  typesense: `  typesense:
    image: typesense/typesense:29.0@sha256:316b7e71c21f7e5e5caa8daa150e1b3f2be8c876081ee1f77bc2d92cd7f137d0
    entrypoint: [/bin/sh, /opt/monox/typesense-start.sh]
    ports: ["127.0.0.1:8108:8108"]
    volumes: [../docker/typesense-start.sh:/opt/monox/typesense-start.sh:ro, ../docker/validate-secret.sh:/opt/monox/validate-secret.sh:ro, typesense-data:/data]
    secrets: [typesense_api_key]
    read_only: true
    tmpfs: [/tmp]
    security_opt: [no-new-privileges:true]
`,
  opensearch: `  opensearch:
    image: opensearchproject/opensearch:3.3.2@sha256:798cf28e226a32f5c928dd1ed9478dd3a33d2212176aad3679020088ad3afa1a
    environment:
      discovery.type: single-node
      OPENSEARCH_INITIAL_ADMIN_PASSWORD: \${OPENSEARCH_INITIAL_ADMIN_PASSWORD:?Set OPENSEARCH_INITIAL_ADMIN_PASSWORD}
    ports: ["127.0.0.1:9200:9200"]
    volumes: [opensearch-data:/usr/share/opensearch/data]
    security_opt: [no-new-privileges:true]
`,
  minio: `  minio:
    image: quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e
    command: [server, /data, --console-address, ":9001"]
    environment:
      MINIO_ROOT_USER: \${MINIO_ROOT_USER:?Set MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: \${MINIO_ROOT_PASSWORD:?Set MINIO_ROOT_PASSWORD}
    ports: ["127.0.0.1:9000:9000", "127.0.0.1:9001:9001"]
    volumes: [minio-data:/data]
    security_opt: [no-new-privileges:true]
`,
  keycloak: `  keycloak:
    image: quay.io/keycloak/keycloak:26.4.2@sha256:3617b09bb4b7510a8d8d9b9fc5707399e2d70688dbcc2f8fb013a144829be1b9
    command: [start-dev]
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: \${KEYCLOAK_ADMIN_USERNAME:?Set KEYCLOAK_ADMIN_USERNAME}
      KC_BOOTSTRAP_ADMIN_PASSWORD: \${KEYCLOAK_ADMIN_PASSWORD:?Set KEYCLOAK_ADMIN_PASSWORD}
      KC_HEALTH_ENABLED: "true"
      KC_METRICS_ENABLED: "true"
    ports: ["127.0.0.1:8081:8080"]
    volumes: [keycloak-data:/opt/keycloak/data]
    security_opt: [no-new-privileges:true]
`,
  flipt: `  flipt:
    image: docker.flipt.io/flipt/flipt:v1.60.0@sha256:5ca2de7f408fb8435380c6fe26eb9a3faff0064a9ee9a5c67fe44a83d652a987
    ports: ["127.0.0.1:8082:8080"]
    volumes: [flipt-data:/var/opt/flipt]
    security_opt: [no-new-privileges:true]
`,
  mailpit: `  mailpit:
    image: axllent/mailpit:v1.27.8@sha256:6abc8e633df15eaf785cfcf38bae48e66f64beecdc03121e249d0f9ec15f0707
    ports: ["127.0.0.1:1025:1025", "127.0.0.1:8025:8025"]
    read_only: true
    tmpfs: [/tmp]
    security_opt: [no-new-privileges:true]
`,
  'otel-collector': `  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.137.0@sha256:886722fe0f37af9d1fe24d29529253ec59fbf263b3b1df4facaf221373e19d23
    command: [--config=/etc/otelcol/config.yaml]
    ports: ["127.0.0.1:4317:4317", "127.0.0.1:4318:4318"]
    expose: ["8889"]
    volumes: [../docker/otel-collector.yaml:/etc/otelcol/config.yaml:ro]
    depends_on:
      loki:
        condition: service_started
      prometheus:
        condition: service_started
      tempo:
        condition: service_started
    read_only: true
    tmpfs: [/tmp]
    security_opt: [no-new-privileges:true]
`,
  prometheus: `  prometheus:
    image: prom/prometheus:v3.7.1@sha256:ff7e389acbe064a4823212a500393d40a28a8f362e4b05cbf6742a9a3ef736b2
    command: [--config.file=/etc/prometheus/prometheus.yml, --storage.tsdb.path=/prometheus]
    ports: ["127.0.0.1:9090:9090"]
    volumes: [../docker/prometheus.yaml:/etc/prometheus/prometheus.yml:ro, prometheus-data:/prometheus]
    security_opt: [no-new-privileges:true]
`,
  grafana: `  grafana:
    image: grafana/grafana:12.2.0@sha256:74144189b38447facf737dfd0f3906e42e0776212bf575dc3334c3609183adf7
    environment:
      GF_SECURITY_ADMIN_USER: \${GRAFANA_ADMIN_USER:?Set GRAFANA_ADMIN_USER}
      GF_SECURITY_ADMIN_PASSWORD: \${GRAFANA_ADMIN_PASSWORD:?Set GRAFANA_ADMIN_PASSWORD}
      GF_USERS_ALLOW_SIGN_UP: "false"
      GF_AUTH_ANONYMOUS_ENABLED: "false"
      GF_ANALYTICS_REPORTING_ENABLED: "false"
      GF_ANALYTICS_CHECK_FOR_UPDATES: "false"
      GF_UPDATE_CHECK_ENABLED: "false"
    ports: ["127.0.0.1:3002:3000"]
    volumes: [../docker/grafana-datasources.yaml:/etc/grafana/provisioning/datasources/monox.yaml:ro, grafana-data:/var/lib/grafana]
    depends_on:
      otel-collector:
        condition: service_started
    security_opt: [no-new-privileges:true]
`,
  loki: `  loki:
    image: grafana/loki:3.5.7@sha256:0eaee7bf39cc83aaef46914fb58f287d4f4c4be6ec96b86c2ed55719a75e49c8
    command: [-config.file=/etc/loki/monox.yaml]
    ports: ["127.0.0.1:3100:3100"]
    volumes: [../docker/loki.yaml:/etc/loki/monox.yaml:ro, loki-data:/loki]
    security_opt: [no-new-privileges:true]
`,
  tempo: `  tempo:
    image: grafana/tempo:2.9.0@sha256:65a5789759435f1ef696f1953258b9bbdb18eb571d5ce711ff812d2e128288a4
    command: [-config.file=/etc/tempo.yaml]
    ports: ["127.0.0.1:3200:3200", "127.0.0.1:14317:4317"]
    volumes: [../docker/tempo.yaml:/etc/tempo.yaml:ro, tempo-data:/var/tempo]
    security_opt: [no-new-privileges:true]
`,
});

const volumeByAddon = Object.freeze({
  postgresql: 'postgresql-data',
  mongodb: 'mongodb-data',
  redis: 'redis-data',
  rabbitmq: 'rabbitmq-data',
  nats: 'nats-data',
  redpanda: 'redpanda-data',
  localstack: 'localstack-data',
  ollama: 'ollama-data',
  qdrant: 'qdrant-data',
  typesense: 'typesense-data',
  opensearch: 'opensearch-data',
  minio: 'minio-data',
  keycloak: 'keycloak-data',
  flipt: 'flipt-data',
  prometheus: 'prometheus-data',
  grafana: 'grafana-data',
  loki: 'loki-data',
  tempo: 'tempo-data',
});

const requiredEnvironment = Object.freeze({
  postgresql: ['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'],
  mongodb: ['MONGODB_ROOT_USERNAME', 'MONGODB_ROOT_PASSWORD'],
  rabbitmq: ['RABBITMQ_USERNAME', 'RABBITMQ_PASSWORD'],
  temporal: ['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'],
  qdrant: ['QDRANT_API_KEY'],
  opensearch: ['OPENSEARCH_INITIAL_ADMIN_PASSWORD'],
  minio: ['MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD'],
  keycloak: ['KEYCLOAK_ADMIN_USERNAME', 'KEYCLOAK_ADMIN_PASSWORD'],
  grafana: ['GRAFANA_ADMIN_USER', 'GRAFANA_ADMIN_PASSWORD'],
});

const localSecretByAddon = Object.freeze({
  redis: Object.freeze({ composeName: 'redis_password', fileName: 'redis-password' }),
  nats: Object.freeze({ composeName: 'nats_token', fileName: 'nats-token' }),
  typesense: Object.freeze({ composeName: 'typesense_api_key', fileName: 'typesense-api-key' }),
});

const validateSecretScript = `#!/bin/sh

validate_secret() {
  secret_file="$1"
  if [ ! -s "$secret_file" ] || [ "$(awk 'END { print NR }' "$secret_file")" -ne 1 ] || ! grep -Eq '^[A-Za-z0-9_-]+$' "$secret_file"; then
    echo "MonoX secret file must contain exactly one base64url line." >&2
    return 1
  fi
  secret_characters="$(tr -d '\n' < "$secret_file" | wc -c | tr -d ' ')"
  if [ "$secret_characters" -lt 32 ] || [ "$secret_characters" -gt 256 ]; then
    echo "MonoX secret must contain 32 to 256 base64url characters." >&2
    return 1
  fi
}
`;

const supportFiles = Object.freeze({
  redis: {
    'infra/docker/redis-start.sh':
      '#!/bin/sh\nset -eu\n\nsecret_file=/run/secrets/redis_password\nconfig_file=/tmp/monox-redis.conf\n. /opt/monox/validate-secret.sh\nvalidate_secret "$secret_file"\numask 077\n{\n  printf "appendonly yes\\n"\n  sed "s/^/requirepass /" "$secret_file"\n} > "$config_file"\nexec redis-server "$config_file"\n',
    'infra/docker/redis-healthcheck.sh':
      '#!/bin/sh\nset -eu\n\nsecret_file=/run/secrets/redis_password\n. /opt/monox/validate-secret.sh\nvalidate_secret "$secret_file"\nredis-cli --askpass ping < "$secret_file" | grep -qx PONG\n',
    'infra/docker/validate-secret.sh': validateSecretScript,
  },
  nats: {
    'infra/docker/nats-start.sh':
      '#!/bin/sh\nset -eu\n\nsecret_file=/run/secrets/nats_token\nconfig_file=/tmp/monox-nats.conf\n. /opt/monox/validate-secret.sh\nvalidate_secret "$secret_file"\numask 077\n{\n  printf "jetstream {\\n  store_dir: \\\"/data\\\"\\n}\\nauthorization {\\n  token: \\\""\n  tr -d "\\n" < "$secret_file"\n  printf "\\\"\\n}\\n"\n} > "$config_file"\nexec /usr/local/bin/nats-server --config "$config_file"\n',
    'infra/docker/validate-secret.sh': validateSecretScript,
  },
  typesense: {
    'infra/docker/typesense-start.sh':
      '#!/bin/sh\nset -eu\n\nsecret_file=/run/secrets/typesense_api_key\nconfig_file=/tmp/monox-typesense.ini\n. /opt/monox/validate-secret.sh\nvalidate_secret "$secret_file"\numask 077\n{\n  printf "[server]\\ndata-dir = /data\\napi-key = "\n  cat "$secret_file"\n} > "$config_file"\nexec /opt/typesense-server --config "$config_file"\n',
    'infra/docker/validate-secret.sh': validateSecretScript,
  },
  'otel-collector': {
    'infra/docker/otel-collector.yaml':
      'receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n      http:\n        endpoint: 0.0.0.0:4318\nexporters:\n  debug: {}\n  otlp/tempo:\n    endpoint: tempo:4317\n    tls:\n      insecure: true\n  otlphttp/loki:\n    endpoint: http://loki:3100/otlp\n  prometheus:\n    endpoint: 0.0.0.0:8889\nservice:\n  telemetry:\n    logs:\n      level: info\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [otlp/tempo, debug]\n    metrics:\n      receivers: [otlp]\n      exporters: [prometheus, debug]\n    logs:\n      receivers: [otlp]\n      exporters: [otlphttp/loki, debug]\n',
  },
  prometheus: {
    'infra/docker/prometheus.yaml':
      'global:\n  scrape_interval: 15s\nscrape_configs:\n  - job_name: prometheus\n    static_configs:\n      - targets: [prometheus:9090]\n  - job_name: otel-collector\n    static_configs:\n      - targets: [otel-collector:8889]\n',
  },
  grafana: {
    'infra/docker/grafana-datasources.yaml':
      'apiVersion: 1\ndatasources:\n  - name: Prometheus\n    uid: monox-prometheus\n    type: prometheus\n    access: proxy\n    url: http://prometheus:9090\n    isDefault: true\n    editable: false\n  - name: Loki\n    uid: monox-loki\n    type: loki\n    access: proxy\n    url: http://loki:3100\n    editable: false\n  - name: Tempo\n    uid: monox-tempo\n    type: tempo\n    access: proxy\n    url: http://tempo:3200\n    editable: false\n',
  },
  loki: {
    'infra/docker/loki.yaml':
      'auth_enabled: false\nserver:\n  http_listen_port: 3100\ncommon:\n  path_prefix: /loki\n  replication_factor: 1\n  ring:\n    kvstore:\n      store: inmemory\n  storage:\n    filesystem:\n      chunks_directory: /loki/chunks\n      rules_directory: /loki/rules\nschema_config:\n  configs:\n    - from: 2024-04-01\n      store: tsdb\n      object_store: filesystem\n      schema: v13\n      index:\n        prefix: index_\n        period: 24h\nlimits_config:\n  allow_structured_metadata: true\nanalytics:\n  reporting_enabled: false\n',
  },
  tempo: {
    'infra/docker/tempo.yaml':
      'server:\n  http_listen_port: 3200\ndistributor:\n  receivers:\n    otlp:\n      protocols:\n        grpc:\n          endpoint: 0.0.0.0:4317\nstorage:\n  trace:\n    backend: local\n    local:\n      path: /var/tempo/traces\nusage_report:\n  reporting_enabled: false\n',
  },
});

const addonDependencies = Object.freeze({
  temporal: Object.freeze(['postgresql']),
  'otel-collector': Object.freeze(['loki', 'prometheus', 'tempo']),
  grafana: Object.freeze(['otel-collector']),
});

export function expandAddonDependencies(addonIds) {
  const expanded = new Set();
  const visiting = new Set();

  function visit(id) {
    assertAddon(id);
    if (expanded.has(id)) return;
    if (visiting.has(id)) throw new Error(`Add-on dependency cycle detected at ${id}.`);
    visiting.add(id);
    for (const dependency of addonDependencies[id] ?? []) visit(dependency);
    visiting.delete(id);
    expanded.add(id);
  }

  for (const id of addonIds) visit(id);
  return [...expanded].sort();
}

export function validateAddonsForEnvironment(addonIds, environment) {
  for (const id of addonIds) {
    const definition = assertAddon(id);
    if (environment === 'production' && !definition.production) {
      throw new Error(`${id} is a development-only add-on and cannot be enabled in production.`);
    }
  }
}

export function localSecretFilesForAddons(addonIds) {
  return addonIds
    .map((id) => localSecretByAddon[id])
    .filter(Boolean)
    .sort((left, right) => left.composeName.localeCompare(right.composeName));
}

export function renderAddonFiles(addonIds) {
  const files = new Map();
  const composeIds = addonIds.filter((id) => ADDON_RECIPES[id].compose);
  const kubernetesIds = addonIds.filter((id) => ADDON_RECIPES[id].kubernetes);

  if (composeIds.length > 0) {
    const missingRenderers = composeIds.filter((id) => typeof composeServices[id] !== 'string');
    if (missingRenderers.length > 0) {
      throw new Error(`Compose add-ons have no renderer: ${missingRenderers.join(', ')}.`);
    }
    const services = composeIds.map((id) => composeServices[id]).join('');
    const volumes = composeIds
      .map((id) => volumeByAddon[id])
      .filter(Boolean)
      .map((name) => `  ${name}: {}`)
      .join('\n');
    const localSecrets = localSecretFilesForAddons(composeIds);
    const secrets = localSecrets
      .map(({ composeName, fileName }) => `  ${composeName}:\n    file: ../../.monox/secrets/${fileName}`)
      .join('\n');
    files.set(
      'infra/docker/addons.compose.yaml',
      `services:\n${services}${volumes ? `volumes:\n${volumes}\n` : ''}${secrets ? `secrets:\n${secrets}\n` : ''}`
    );

    const envNames = [...new Set(composeIds.flatMap((id) => requiredEnvironment[id] ?? []))].sort();
    if (envNames.length > 0) files.set('.env.example', `${envNames.map((name) => `${name}=`).join('\n')}\n`);
    if (localSecrets.length > 0) {
      files.set('scripts/init-local-secrets.mjs', localSecretsInitializer(localSecrets));
    }
    for (const id of composeIds) {
      for (const [path, contents] of Object.entries(supportFiles[id] ?? {})) files.set(path, contents);
    }
  }

  if (kubernetesIds.length > 0) {
    files.set(
      'infra/kubernetes/addons.json',
      `${JSON.stringify(
        {
          schemaVersion: '1',
          installMode: 'helm-oci',
          addons: kubernetesIds.map((id) => ({
            id,
            version: ADDON_RECIPES[id].version,
            install: ADDON_RECIPES[id].install,
          })),
        },
        null,
        2
      )}\n`
    );
  }

  if (addonIds.length > 0) {
    files.set('infra/ADDONS.md', addonReadme(addonIds));
  }
  return files;
}

function addonReadme(addonIds) {
  const hasLocalSecrets = localSecretFilesForAddons(addonIds).length > 0;
  return `# Generated add-ons\n\nSelected recipes: ${addonIds.map((id) => `\`${id}\``).join(', ')}.\n\nCompose ports bind to loopback. Required non-file values are listed with empty placeholders in \`.env.example\`; copy that file to the ignored \`.env\` and provide values before startup. No production credential belongs in either file.${hasLocalSecrets ? ' Redis, NATS and Typesense credentials are mounted from ignored files under `.monox/secrets`; run the root `local:secrets` script before the first Compose start. Their values are not placed in the container command or Compose environment.' : ''}\n\nStateful Kubernetes add-ons are opt-in. Prefer a managed service in production and review storage, backups, authentication, network policy and resource limits before applying any rendered chart.\n`;
}

function localSecretsInitializer(localSecrets) {
  const fileNames = localSecrets.map(({ fileName }) => fileName);
  return `import { randomBytes } from 'node:crypto';\nimport { chmod, lstat, mkdir, open, readFile } from 'node:fs/promises';\n\nconst root = new URL('../.monox/', import.meta.url);\nconst directory = new URL('secrets/', root);\nconst fileNames = Object.freeze(${JSON.stringify(fileNames)});\nfor (const path of [root, directory]) {\n  await mkdir(path, { recursive: true, mode: 0o700 });\n  const metadata = await lstat(path);\n  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {\n    throw new Error('Local secret directory must be a real directory, not a symlink.');\n  }\n  await chmod(path, 0o700);\n}\nlet created = 0;\nlet kept = 0;\nfor (const fileName of fileNames) {\n  const path = new URL(fileName, directory);\n  let handle;\n  try {\n    handle = await open(path, 'wx', 0o600);\n  } catch (error) {\n    if (error?.code !== 'EEXIST') throw error;\n    const metadata = await lstat(path);\n    const value = metadata.isFile() && !metadata.isSymbolicLink() ? await readFile(path, 'utf8') : '';\n    if ((metadata.mode & 0o777) !== 0o600 || !/^[A-Za-z0-9_-]{32,256}\\n?$/.test(value)) {\n      throw new Error(\`Unsafe existing local secret file: \${fileName}.\`);\n    }\n    kept += 1;\n    continue;\n  }\n  try {\n    await handle.writeFile(\`\${randomBytes(32).toString('base64url')}\\n\`, 'utf8');\n    await handle.chmod(0o600);\n    created += 1;\n  } finally {\n    await handle.close();\n  }\n}\nconsole.log(\`Local secret files ready: \${created} created, \${kept} kept.\`);\n`;
}
