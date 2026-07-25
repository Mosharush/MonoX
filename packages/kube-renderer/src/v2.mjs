import { assertValidDeploymentSpecV2 } from '@monox/deploy-schema';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SECRET_NAME = /(?:password|passwd|secret|token|private[_-]?key|credential)/i;
const LONG_LIVED_KINDS = new Set(['service', 'worker', 'model', 'static']);
const NETWORK_KINDS = new Set(['service', 'worker', 'model', 'static']);
const VALID_KINDS = new Set([...LONG_LIVED_KINDS, 'cron', 'job']);
const KEDA_SCALER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, compact(item)])
  );
}

function fail(path, message) {
  throw new TypeError(`Invalid resolved deployment v2 at ${path}: ${message}`);
}

function integer(value, path, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    fail(path, `must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function nonEmpty(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty string');
  return value;
}

function dnsLabel(value, path) {
  nonEmpty(value, path);
  if (!DNS_LABEL.test(value)) fail(path, 'must be a Kubernetes DNS label');
  return value;
}

function stringMap(value, path) {
  if (value === undefined) return {};
  if (!object(value)) fail(path, 'must be an object containing string values');
  for (const [key, item] of Object.entries(value)) {
    nonEmpty(key, `${path}.${key}`);
    if (typeof item !== 'string') fail(`${path}.${key}`, 'must be a string');
  }
  return structuredClone(value);
}

function deploymentFrom(input) {
  const candidate = input?.deployment ?? input;
  if (!object(candidate)) fail('$', 'must be an object');
  const deployment = assertValidDeploymentSpecV2(candidate);
  if (deployment.enabled === false) fail('$.enabled', 'disabled workloads cannot be rendered');
  const id = dnsLabel(deployment.id, '$.id');
  if (!VALID_KINDS.has(deployment.kind))
    fail('$.kind', `must be one of ${[...VALID_KINDS].sort().join(', ')}`);

  const target = input?.target ?? {};
  const environment = input?.environment ?? deployment.environment ?? 'default';
  const namespace =
    deployment.adapterOverrides?.kubernetes?.namespace ??
    target.bindings?.namespace ??
    `${id}-${environment}`;
  dnsLabel(namespace, '$.namespace');

  validateWorkerLifecycle(deployment);

  return { deployment: structuredClone(deployment), environment, id, namespace, target };
}

function validateWorkerLifecycle(deployment) {
  if (deployment.kind !== 'worker' || deployment.suspended === true) return;
  const lifecycle = deployment.lifecycle ?? {};
  const drain = lifecycle.drain ?? {};
  if (drain.enabled !== true)
    fail('$.lifecycle.drain.enabled', 'long-running workers must declare an enabled drain contract');
  if (!Array.isArray(lifecycle.preStopCommand) || lifecycle.preStopCommand.length === 0)
    fail('$.lifecycle.preStopCommand', 'long-running workers must declare a drain command');
  const timeout = drain.timeoutSeconds ?? 30;
  const grace = lifecycle.terminationGracePeriodSeconds ?? 60;
  if (grace < timeout)
    fail(
      '$.lifecycle.terminationGracePeriodSeconds',
      'must be greater than or equal to lifecycle.drain.timeoutSeconds'
    );
}

function labels(config) {
  return {
    'app.kubernetes.io/name': config.id,
    'app.kubernetes.io/instance': config.id,
    'app.kubernetes.io/managed-by': 'monox',
    'monox.dev/environment': config.environment,
    ...stringMap(config.deployment.labels, '$.labels'),
  };
}

function metadata(config, name = config.id, additions = {}) {
  return compact({
    name,
    namespace: config.namespace,
    labels: { ...labels(config), ...additions.labels },
    annotations: additions.annotations,
  });
}

function namespaceResource(config) {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: config.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'monox',
        'pod-security.kubernetes.io/enforce': 'restricted',
        'pod-security.kubernetes.io/warn': 'restricted',
        'pod-security.kubernetes.io/audit': 'restricted',
      },
    },
  };
}

function image(config) {
  const build = config.deployment.build ?? {};
  const candidate = build.image;
  if (typeof candidate === 'string') {
    const tag = candidate.match(/:([^/:]+)$/)?.[1];
    if (!candidate.includes('@sha256:') && (!tag || tag === 'latest'))
      fail('$.build.image', 'must use an immutable tag or digest');
    return candidate;
  }
  if (!object(candidate)) fail('$.build.image', 'must resolve to an image string or repository/tag object');
  nonEmpty(candidate.repository, '$.build.image.repository');
  nonEmpty(candidate.tag ?? candidate.digest, '$.build.image.tag');
  if (candidate.tag === 'latest') fail('$.build.image.tag', 'latest is not allowed');
  return candidate.digest
    ? `${candidate.repository}@${candidate.digest.replace(/^@/, '')}`
    : `${candidate.repository}:${candidate.tag}`;
}

function ports(config) {
  const network = config.deployment.network ?? {};
  const values = network.ports ?? (network.port ? [{ name: 'http', containerPort: network.port }] : []);
  if (!Array.isArray(values)) fail('$.network.ports', 'must be an array');
  return values.map((port, index) => {
    if (!object(port)) fail(`$.network.ports[${index}]`, 'must be an object');
    const containerPort = integer(
      port.containerPort ?? port.targetPort ?? port.port,
      `$.network.ports[${index}].containerPort`,
      1,
      65535
    );
    return {
      name: dnsLabel(
        port.name ?? (index === 0 ? 'http' : `port-${index + 1}`),
        `$.network.ports[${index}].name`
      ),
      containerPort,
      servicePort: integer(
        port.servicePort ?? port.port ?? containerPort,
        `$.network.ports[${index}].servicePort`,
        1,
        65535
      ),
      protocol: port.protocol ?? 'TCP',
    };
  });
}

function hasNetwork(config) {
  const exposure = config.deployment.network?.exposure ?? 'none';
  const configuredPorts = ports(config);
  if (config.deployment.kind === 'worker' && exposure === 'none') return false;
  return exposure !== 'none' && configuredPorts.length > 0 && NETWORK_KINDS.has(config.deployment.kind);
}

function normalizeProbe(value, path, defaultPort) {
  if (!object(value)) fail(path, 'must be an object');
  const timing = {
    initialDelaySeconds: value.delaySeconds ?? value.initialDelaySeconds,
    periodSeconds: value.periodSeconds ?? 10,
    timeoutSeconds: value.timeoutSeconds ?? 3,
    failureThreshold: value.failureThreshold ?? 3,
    successThreshold: value.successThreshold ?? 1,
  };
  if (value.type === 'http' || value.http || value.httpGet || value.path) {
    const source = value.http ?? value.httpGet ?? value;
    return compact({
      httpGet: {
        path: source.path ?? '/',
        port: source.port ?? defaultPort,
        scheme: source.scheme ?? 'HTTP',
      },
      ...timing,
    });
  }
  if (value.type === 'tcp' || value.tcp || value.tcpSocket) {
    const source = value.tcp ?? value.tcpSocket ?? value;
    return compact({ tcpSocket: { port: source.port ?? defaultPort }, ...timing });
  }
  if (value.type === 'exec' || value.exec) {
    const command = value.exec?.command ?? value.command;
    if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== 'string'))
      fail(`${path}.exec.command`, 'must contain command arguments');
    return compact({ exec: { command }, ...timing });
  }
  fail(path, 'must define an HTTP, TCP, or exec probe');
}

function probes(config, defaultPort) {
  const source = config.deployment.probes;
  if (!object(source)) fail('$.probes', 'startup, readiness, and liveness probes are required');
  return {
    startupProbe: normalizeProbe(source.startup, '$.probes.startup', defaultPort),
    readinessProbe: normalizeProbe(source.readiness, '$.probes.readiness', defaultPort),
    livenessProbe: normalizeProbe(source.liveness, '$.probes.liveness', defaultPort),
  };
}

function quantities(config) {
  const resources = config.deployment.resources;
  if (!object(resources?.requests) || !object(resources?.limits))
    fail('$.resources', 'requests and limits are required');
  for (const name of ['cpu', 'memory']) {
    nonEmpty(resources.requests[name], `$.resources.requests.${name}`);
    nonEmpty(resources.limits[name], `$.resources.limits.${name}`);
  }
  const requests = kubernetesQuantities(resources.requests);
  const limits = kubernetesQuantities(resources.limits);
  const accelerators = resources.accelerators ?? (resources.gpu ? [resources.gpu] : []);
  if (!Array.isArray(accelerators)) fail('$.resources.accelerators', 'must be an array');
  for (const [index, accelerator] of accelerators.entries()) {
    if (!object(accelerator)) fail(`$.resources.accelerators[${index}]`, 'must be an object');
    const resourceName = accelerator.resourceName ?? accelerator.type ?? 'nvidia.com/gpu';
    if (!resourceName.includes('/'))
      fail(`$.resources.accelerators[${index}].resourceName`, 'must be an extended resource name');
    const count = integer(accelerator.count ?? 1, `$.resources.accelerators[${index}].count`, 1, 64);
    requests[resourceName] = String(count);
    limits[resourceName] = String(count);
  }
  return { requests, limits };
}

function kubernetesQuantities(value) {
  const result = { ...value };
  if (result.ephemeralStorage !== undefined) {
    result['ephemeral-storage'] = result.ephemeralStorage;
    delete result.ephemeralStorage;
  }
  return result;
}

function environment(config) {
  const env = config.deployment.env ?? {};
  const values = stringMap(env.values, '$.env.values');
  const result = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value }));
  const secretRefs = env.secretRefs ?? [];
  if (!Array.isArray(secretRefs)) fail('$.env.secretRefs', 'must be an array');
  for (const [index, reference] of secretRefs.entries()) {
    if (!object(reference)) fail(`$.env.secretRefs[${index}]`, 'must be an object');
    const logicalName = nonEmpty(reference.name, `$.env.secretRefs[${index}].name`);
    const envName = reference.target ?? logicalName.replace(/-/g, '_').toUpperCase();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName))
      fail(`$.env.secretRefs[${index}].target`, 'must resolve to an environment variable name');
    result.push({
      name: envName,
      valueFrom: {
        secretKeyRef: {
          name: dnsLabel(logicalName, `$.env.secretRefs[${index}].name`),
          key: nonEmpty(reference.key ?? logicalName, `$.env.secretRefs[${index}].key`),
          optional: reference.optional === true ? true : undefined,
        },
      },
    });
  }
  return result;
}

function storage(config) {
  const entries = config.deployment.storage ?? [];
  if (!Array.isArray(entries)) fail('$.storage', 'must be an array');
  const volumes = [];
  const mounts = [];
  const claims = [];
  let perReplica = false;
  for (const [index, item] of entries.entries()) {
    const path = `$.storage[${index}]`;
    if (!object(item)) fail(path, 'must be an object');
    const name = dnsLabel(item.name, `${path}.name`);
    const mountPath = nonEmpty(item.mountPath, `${path}.mountPath`);
    const type = item.type ?? 'ephemeral';
    mounts.push({ name, mountPath, readOnly: item.readOnly === true ? true : undefined });
    if (type === 'ephemeral') {
      volumes.push({ name, emptyDir: { sizeLimit: item.size ?? '1Gi' } });
    } else if (type === 'persistent') {
      if (config.deployment.kind === 'model') {
        perReplica = true;
        claims.push(claimTemplate(config, item, path));
      } else {
        const claimName = item.sourceRef ?? `${config.id}-${name}`;
        volumes.push({
          name,
          persistentVolumeClaim: { claimName, readOnly: item.readOnly === true ? true : undefined },
        });
        claims.push(claimResource(config, item, claimName, path));
      }
    } else if (type === 'secret') {
      volumes.push({
        name,
        secret: { secretName: dnsLabel(item.sourceRef, `${path}.sourceRef`), defaultMode: 256 },
      });
    } else if (type === 'config') {
      volumes.push({ name, configMap: { name: dnsLabel(item.sourceRef, `${path}.sourceRef`) } });
    } else fail(`${path}.type`, 'must be ephemeral, persistent, secret, or config');
  }
  return { volumes, mounts, claims, perReplica };
}

function claimTemplate(config, item, path) {
  const size = nonEmpty(item.size ?? item.sizeLimit, `${path}.size`);
  return compact({
    metadata: { name: item.name, labels: labels(config) },
    spec: {
      accessModes: item.accessModes ?? ['ReadWriteOnce'],
      storageClassName: item.className,
      resources: { requests: { storage: size } },
    },
  });
}

function claimResource(config, item, name, path) {
  const template = claimTemplate(config, { ...item, name }, path);
  return { apiVersion: 'v1', kind: 'PersistentVolumeClaim', ...template };
}

function serviceAccountResource(config) {
  const identity = config.deployment.identity ?? {};
  const overrides = config.deployment.adapterOverrides?.kubernetes ?? {};
  const name = overrides.serviceAccountName ?? identity.serviceAccount ?? config.id;
  if (name === 'default') fail('$.identity.serviceAccountName', 'default ServiceAccount is not allowed');
  dnsLabel(name, '$.identity.serviceAccountName');
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: metadata(config, name, {
      annotations: identityAnnotations(config),
    }),
    automountServiceAccountToken: false,
  };
}

function identityAnnotations(config) {
  const identity = config.deployment.identity ?? {};
  if (config.target.provider === 'gcp' && identity.workloadIdentity)
    return { 'iam.gke.io/gcp-service-account': identity.workloadIdentity };
  if (config.target.provider === 'aws' && identity.providerRoleRef)
    return { 'eks.amazonaws.com/role-arn': identity.providerRoleRef };
  return {};
}

function podSpec(config, storageConfig) {
  const runtime = config.deployment.runtime ?? {};
  const configuredPorts = ports(config);
  const defaultPort = configuredPorts[0]?.name ?? configuredPorts[0]?.containerPort;
  const lifecycle = config.deployment.lifecycle ?? {};
  const container = compact({
    name: config.id,
    image: image(config),
    imagePullPolicy: 'IfNotPresent',
    command: runtime.command,
    workingDir: runtime.workingDirectory,
    ports: configuredPorts.length
      ? configuredPorts.map((port) => ({
          name: port.name,
          containerPort: port.containerPort,
          protocol: port.protocol,
        }))
      : undefined,
    env: environment(config),
    ...probes(config, defaultPort),
    resources: quantities(config),
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
    },
    lifecycle: lifecycle.preStopCommand?.length
      ? {
          preStop: {
            exec: { command: lifecycleCommand(lifecycle.preStopCommand, '$.lifecycle.preStopCommand') },
          },
        }
      : undefined,
    volumeMounts: storageConfig.mounts.length ? storageConfig.mounts : [{ name: 'tmp', mountPath: '/tmp' }],
  });
  const scheduling = config.deployment.adapterOverrides?.kubernetes ?? {};
  const identity = config.deployment.identity ?? {};
  const serviceAccountName = scheduling.serviceAccountName ?? identity.serviceAccount ?? config.id;
  return compact({
    serviceAccountName,
    automountServiceAccountToken: false,
    restartPolicy: ['cron', 'job'].includes(config.deployment.kind) ? 'Never' : undefined,
    terminationGracePeriodSeconds: lifecycle.terminationGracePeriodSeconds ?? 60,
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      fsGroup: 10001,
      seccompProfile: { type: 'RuntimeDefault' },
    },
    nodeSelector: scheduling.nodeSelector,
    tolerations: scheduling.tolerations,
    topologySpreadConstraints: topologySpread(config),
    containers: [container],
    volumes: storageConfig.volumes.length
      ? storageConfig.volumes
      : [{ name: 'tmp', emptyDir: { sizeLimit: '256Mi' } }],
  });
}

function lifecycleCommand(value, path) {
  const command = value?.command ?? value;
  if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== 'string'))
    fail(path, 'must contain command arguments');
  return command;
}

function topologySpread(config) {
  if (['cron', 'job'].includes(config.deployment.kind)) return undefined;
  const keys = ['topology.kubernetes.io/zone', 'kubernetes.io/hostname'];
  return keys.map((topologyKey) => ({
    maxSkew: 1,
    topologyKey,
    whenUnsatisfiable: 'ScheduleAnyway',
    labelSelector: { matchLabels: labels(config) },
  }));
}

function podTemplate(config, storageConfig) {
  return {
    metadata: { labels: labels(config) },
    spec: podSpec(config, storageConfig),
  };
}

function workloadResource(config, storageConfig) {
  const template = podTemplate(config, storageConfig);
  if (config.deployment.kind === 'job') {
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: metadata(config),
      spec: {
        backoffLimit: 3,
        ttlSecondsAfterFinished: 3600,
        template,
      },
    };
  }
  if (config.deployment.kind === 'cron') {
    const schedule = config.deployment.runtime?.cron;
    nonEmpty(schedule, '$.runtime.cron');
    return {
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: metadata(config),
      spec: compact({
        schedule,
        timeZone: config.deployment.runtime?.tuning?.timeZone,
        suspend: config.deployment.suspended === true ? true : undefined,
        concurrencyPolicy: 'Forbid',
        successfulJobsHistoryLimit: 3,
        failedJobsHistoryLimit: 1,
        jobTemplate: {
          spec: {
            backoffLimit: 3,
            ttlSecondsAfterFinished: 86400,
            template,
          },
        },
      }),
    };
  }
  const scaling = config.deployment.scaling ?? { mode: 'none' };
  const replicas =
    config.deployment.suspended === true
      ? 0
      : scaling.mode === 'none'
        ? (scaling.minReplicas ?? 1)
        : undefined;
  if (storageConfig.perReplica) {
    return {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: metadata(config),
      spec: compact({
        serviceName: `${config.id}-headless`,
        replicas,
        podManagementPolicy: 'Parallel',
        updateStrategy: { type: 'RollingUpdate' },
        selector: { matchLabels: labels(config) },
        template,
        volumeClaimTemplates: storageConfig.claims,
      }),
    };
  }
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: metadata(config),
    spec: compact({
      replicas,
      revisionHistoryLimit: 3,
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: { maxSurge: '25%', maxUnavailable: 0 },
      },
      selector: { matchLabels: labels(config) },
      template,
    }),
  };
}

function serviceResource(config, name = config.id, headless = false) {
  const configuredPorts = ports(config);
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: metadata(config, name),
    spec: compact({
      type: headless ? undefined : 'ClusterIP',
      clusterIP: headless ? 'None' : undefined,
      publishNotReadyAddresses: headless ? true : undefined,
      selector: labels(config),
      ports: configuredPorts.map((port) => ({
        name: port.name,
        port: port.servicePort,
        targetPort: port.name,
        protocol: port.protocol,
      })),
    }),
  };
}

function ingressResources(config) {
  const network = config.deployment.network ?? {};
  if (network.exposure !== 'public') return [];
  if (!hasNetwork(config))
    fail('$.network.exposure', 'public exposure is not supported for this workload kind');
  const routes = network.routes ?? [];
  if (!Array.isArray(routes) || routes.length === 0)
    fail('$.network.routes', 'public exposure requires at least one route');
  const defaultPort = ports(config)[0];
  return routes.map((route, index) => {
    const host = route.host;
    if (host !== undefined) nonEmpty(host, `$.network.routes[${index}].host`);
    if (route.tlsSecretRef && !host)
      fail(`$.network.routes[${index}].host`, 'is required when tlsSecretRef is configured');
    return {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: metadata(config, routes.length === 1 ? config.id : `${config.id}-${index + 1}`),
      spec: compact({
        rules: [
          {
            host,
            http: {
              paths: [
                {
                  path: route.path ?? '/',
                  pathType: route.pathType ?? 'Prefix',
                  backend: {
                    service: { name: config.id, port: { name: route.portName ?? defaultPort.name } },
                  },
                },
              ],
            },
          },
        ],
        tls: route.tlsSecretRef ? [{ hosts: [host], secretName: route.tlsSecretRef }] : undefined,
      }),
    };
  });
}

function pdbResource(config) {
  const scaling = config.deployment.scaling ?? {};
  const potentialReplicas = scaling.maxReplicas ?? scaling.minReplicas ?? 1;
  if (config.deployment.suspended === true || potentialReplicas < 2) return undefined;
  return {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: metadata(config),
    spec: {
      maxUnavailable: 1,
      selector: { matchLabels: labels(config) },
    },
  };
}

function networkPolicyResource(config, networkEnabled) {
  const ingressFrom = [{ namespaceLabels: { 'monox.dev/gateway-access': 'true' } }];
  const ingress = networkEnabled
    ? [
        compact({
          from: ingressFrom.map((peer) =>
            compact({
              namespaceSelector: peer.namespaceLabels ? { matchLabels: peer.namespaceLabels } : undefined,
              podSelector: peer.podLabels ? { matchLabels: peer.podLabels } : undefined,
            })
          ),
          ports: ports(config).map((port) => ({ protocol: port.protocol, port: port.containerPort })),
        }),
      ]
    : [];
  if (networkEnabled && config.deployment.telemetry?.metrics?.enabled) {
    const metricsPort =
      ports(config).find((port) => port.containerPort === config.deployment.telemetry.metrics.port) ??
      ports(config).find((port) => port.name === 'metrics');
    if (!metricsPort) fail('$.telemetry.metrics.port', 'must match a declared network port');
    ingress.push({
      from: [
        {
          namespaceSelector: {
            matchLabels: { 'monox.dev/monitoring-access': 'true' },
          },
        },
      ],
      ports: [{ protocol: metricsPort.protocol, port: metricsPort.containerPort }],
    });
  }
  const egress = [
    {
      to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    },
    {
      to: [{ podSelector: {} }],
    },
  ];
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: metadata(config),
    spec: {
      podSelector: { matchLabels: labels(config) },
      policyTypes: ['Ingress', 'Egress'],
      ingress,
      egress,
    },
  };
}

function hpaMetric(metric, path) {
  if (metric.type === 'cpu' || metric.type === 'memory') {
    return {
      type: 'Resource',
      resource: {
        name: metric.type,
        target: {
          type: 'Utilization',
          averageUtilization: integer(metric.target, `${path}.target`, 1, 100),
        },
      },
    };
  }
  if (metric.type === 'rps' || metric.type === 'custom' || metric.type === 'external') {
    const name = nonEmpty(metric.metricName ?? metric.name, `${path}.metricName`);
    return {
      type: 'External',
      external: {
        metric: compact({ name, selector: metric.selector ? { matchLabels: metric.selector } : undefined }),
        target: { type: 'AverageValue', averageValue: String(metric.target) },
      },
    };
  }
  fail(`${path}.type`, 'is not supported by HPA; use KEDA for queue metrics');
}

function hpaResource(config, workload) {
  const scaling = config.deployment.scaling;
  const metrics = scaling.metrics ?? [];
  if (!metrics.length) fail('$.scaling.metrics', 'HPA requires at least one metric');
  if ((scaling.minReplicas ?? 1) < 1) fail('$.scaling.minReplicas', 'HPA cannot scale to zero');
  return {
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: metadata(config),
    spec: compact({
      scaleTargetRef: { apiVersion: 'apps/v1', kind: workload.kind, name: config.id },
      minReplicas: scaling.minReplicas ?? 1,
      maxReplicas: integer(scaling.maxReplicas, '$.scaling.maxReplicas', 1, 1000),
      behavior: scaleBehavior(scaling.behavior),
      metrics: metrics.map((metric, index) => hpaMetric(metric, `$.scaling.metrics[${index}]`)),
    }),
  };
}

function kedaTrigger(config, metric, path) {
  if (metric.type === 'cpu' || metric.type === 'memory') {
    return { type: metric.type, metricType: 'Utilization', metadata: { value: String(metric.target) } };
  }
  if (metric.type === 'rps') {
    const address = /^https?:\/\//.test(metric.sourceRef) ? metric.sourceRef : undefined;
    return {
      type: 'prometheus',
      metadata: {
        serverAddress: nonEmpty(address, `${path}.sourceRef`),
        metricName: nonEmpty(metric.metricName ?? 'service_rps', `${path}.metricName`),
        query: nonEmpty(metric.query, `${path}.query`),
        threshold: String(metric.target),
      },
      authenticationRef: metric.authenticationRef
        ? { name: dnsLabel(metric.authenticationRef, `${path}.authenticationRef`) }
        : undefined,
    };
  }
  const typeMap = {
    rabbitmq: 'rabbitmq',
    sqs: 'aws-sqs-queue',
    pubsub: 'gcp-pubsub',
    redis: 'redis',
    kafka: 'kafka',
    nats: 'nats-jetstream',
    keda: metric.scaler,
  };
  if (metric.type === 'external')
    fail(`${path}.type`, 'external metrics use HPA; use type keda with an explicit scaler for KEDA');
  const type = typeMap[metric.type];
  nonEmpty(type, `${path}.scalerType`);
  if (metric.type === 'keda' && !KEDA_SCALER_NAME.test(type))
    fail(`${path}.scaler`, 'must be a valid KEDA scaler name');
  const metadataValue = { ...typedKedaMetadata(config, metric, path), ...(metric.metadata ?? {}) };
  if (!object(metadataValue)) fail(`${path}.metadata`, 'must be an object');
  for (const [key, value] of Object.entries(metadataValue)) {
    if (SECRET_NAME.test(key))
      fail(
        `${path}.metadata.${key}`,
        'secret-like metadata is not allowed; use authenticationRef or env reference'
      );
    if (typeof value !== 'string') fail(`${path}.metadata.${key}`, 'must be a string');
  }
  return compact({
    type,
    metadata: metadataValue,
    authenticationRef: metric.authenticationRef
      ? { name: dnsLabel(metric.authenticationRef, `${path}.authenticationRef`) }
      : undefined,
  });
}

function typedKedaMetadata(config, metric, path) {
  switch (metric.type) {
    case 'rabbitmq': {
      requireEnvironmentSource(config, metric.sourceRef, `${path}.sourceRef`);
      return compact({
        protocol: 'auto',
        queueName: nonEmpty(metric.queue, `${path}.queue`),
        mode: 'QueueLength',
        value: String(metric.target),
        hostFromEnv: metric.sourceRef,
      });
    }
    case 'sqs': {
      if (config.target.provider !== 'aws') fail(`${path}.type`, 'sqs scaling requires an aws target');
      requireEnvironmentSource(config, metric.sourceRef, `${path}.sourceRef`);
      return compact({
        queueURLFromEnv: metric.sourceRef,
        queueLength: String(metric.target),
        awsRegion: nonEmpty(metric.metadata?.awsRegion ?? config.target.region, `${path}.metadata.awsRegion`),
      });
    }
    case 'pubsub': {
      if (config.target.provider !== 'gcp') fail(`${path}.type`, 'pubsub scaling requires a gcp target');
      const subscription = metric.topic;
      if (!subscription) requireEnvironmentSource(config, metric.sourceRef, `${path}.sourceRef`);
      return compact({
        mode: 'SubscriptionSize',
        value: String(metric.target),
        subscriptionName: subscription,
        subscriptionNameFromEnv: subscription ? undefined : metric.sourceRef,
      });
    }
    case 'redis': {
      requireEnvironmentSource(config, metric.sourceRef, `${path}.sourceRef`);
      return compact({
        addressFromEnv: metric.sourceRef,
        listName: nonEmpty(metric.queue, `${path}.queue`),
        listLength: String(metric.target),
      });
    }
    case 'kafka':
      return compact({
        bootstrapServers: nonEmpty(metric.sourceRef, `${path}.sourceRef`),
        topic: nonEmpty(metric.topic, `${path}.topic`),
        consumerGroup: nonEmpty(metric.consumerGroup, `${path}.consumerGroup`),
        lagThreshold: String(metric.target),
      });
    case 'nats': {
      const endpoint = normalizeNatsEndpoint(metric.sourceRef, `${path}.sourceRef`);
      return compact({
        natsServerMonitoringEndpoint: endpoint.address,
        useHttps: endpoint.useHttps,
        stream: nonEmpty(metric.stream, `${path}.stream`),
        consumer: nonEmpty(metric.consumerGroup, `${path}.consumerGroup`),
        lagThreshold: String(metric.target),
      });
    }
    default:
      return {};
  }
}

function environmentNames(config) {
  const names = new Set(Object.keys(config.deployment.env?.values ?? {}));
  for (const reference of config.deployment.env?.secretRefs ?? [])
    names.add(reference.target ?? reference.name.replace(/-/g, '_').toUpperCase());
  return names;
}

function requireEnvironmentSource(config, name, path) {
  nonEmpty(name, path);
  if (!environmentNames(config).has(name)) fail(path, `must name an environment value or secretRef target`);
}

function normalizeNatsEndpoint(value, path) {
  nonEmpty(value, path);
  if (!/^https?:\/\//.test(value)) return { address: value };
  try {
    const parsed = new URL(value);
    return { address: parsed.host, useHttps: parsed.protocol === 'https:' ? 'true' : 'false' };
  } catch {
    fail(path, 'must be a valid NATS monitoring endpoint');
  }
}

function defaultScaleBehavior() {
  return {
    scaleUp: {
      stabilizationWindowSeconds: 0,
      selectPolicy: 'Max',
      policies: [
        { type: 'Percent', value: 100, periodSeconds: 60 },
        { type: 'Pods', value: 4, periodSeconds: 60 },
      ],
    },
    scaleDown: {
      stabilizationWindowSeconds: 300,
      selectPolicy: 'Max',
      policies: [{ type: 'Percent', value: 50, periodSeconds: 60 }],
    },
  };
}

function scaleBehavior(value) {
  if (!value) return defaultScaleBehavior();
  const result = defaultScaleBehavior();
  if (value.scaleUpStabilizationSeconds !== undefined)
    result.scaleUp.stabilizationWindowSeconds = value.scaleUpStabilizationSeconds;
  if (value.scaleDownStabilizationSeconds !== undefined)
    result.scaleDown.stabilizationWindowSeconds = value.scaleDownStabilizationSeconds;
  return result;
}

function kedaResource(config, workload) {
  const scaling = config.deployment.scaling;
  const metrics = scaling.metrics ?? [];
  if (!metrics.length) fail('$.scaling.metrics', 'KEDA requires at least one metric');
  if ((scaling.minReplicas ?? 0) === 0 && metrics.every((metric) => ['cpu', 'memory'].includes(metric.type)))
    fail('$.scaling.minReplicas', 'scale to zero requires an external event metric');
  const triggers = metrics.map((metric, index) => kedaTrigger(config, metric, `$.scaling.metrics[${index}]`));
  return {
    apiVersion: 'keda.sh/v1alpha1',
    kind: 'ScaledObject',
    metadata: metadata(config),
    spec: compact({
      scaleTargetRef: { apiVersion: 'apps/v1', kind: workload.kind, name: config.id },
      pollingInterval: scaling.pollingInterval ?? 30,
      cooldownPeriod: scaling.cooldownPeriod ?? 300,
      minReplicaCount: scaling.minReplicas ?? 0,
      maxReplicaCount: integer(scaling.maxReplicas, '$.scaling.maxReplicas', 1, 1000),
      fallback: scaling.fallback,
      advanced: { horizontalPodAutoscalerConfig: { behavior: scaleBehavior(scaling.behavior) } },
      triggers,
    }),
  };
}

function autoscalingResource(config, workload) {
  const scaling = config.deployment.scaling ?? { mode: 'none' };
  if (config.deployment.suspended === true || scaling.mode === 'none') return undefined;
  if (!LONG_LIVED_KINDS.has(config.deployment.kind))
    fail('$.scaling.mode', 'jobs and cron jobs cannot be autoscaled');
  if (scaling.mode === 'hpa') return hpaResource(config, workload);
  if (scaling.mode === 'keda') return kedaResource(config, workload);
  fail('$.scaling.mode', 'must be none, hpa, or keda');
}

function serviceMonitorResource(config) {
  const metrics = config.deployment.telemetry?.metrics;
  if (!metrics?.enabled) return undefined;
  if (!hasNetwork(config))
    fail('$.telemetry.metrics', 'requires a network Service to render a ServiceMonitor');
  const port =
    ports(config).find((item) => item.containerPort === metrics.port)?.name ??
    ports(config).find((item) => item.name === 'metrics')?.name ??
    ports(config)[0]?.name;
  return {
    apiVersion: 'monitoring.coreos.com/v1',
    kind: 'ServiceMonitor',
    metadata: metadata(config),
    spec: {
      selector: { matchLabels: labels(config) },
      namespaceSelector: { matchNames: [config.namespace] },
      endpoints: [
        compact({
          port,
          path: metrics.path ?? '/metrics',
          interval: '30s',
          scrapeTimeout: '10s',
        }),
      ],
    },
  };
}

export function buildKubernetesResourcesV2(input) {
  const config = deploymentFrom(input);
  const storageConfig = storage(config);
  const workload = workloadResource(config, storageConfig);
  const networkEnabled = hasNetwork(config);
  const resources = [namespaceResource(config), serviceAccountResource(config)];
  if (!storageConfig.perReplica) resources.push(...storageConfig.claims);
  if (storageConfig.perReplica) resources.push(serviceResource(config, `${config.id}-headless`, true));
  resources.push(workload);
  if (networkEnabled) resources.push(serviceResource(config));
  resources.push(...ingressResources(config));
  const pdb = LONG_LIVED_KINDS.has(config.deployment.kind) ? pdbResource(config) : undefined;
  if (pdb) resources.push(pdb);
  resources.push(networkPolicyResource(config, networkEnabled));
  const autoscaler = autoscalingResource(config, workload);
  if (autoscaler) resources.push(autoscaler);
  const serviceMonitor = serviceMonitorResource(config);
  if (serviceMonitor) resources.push(serviceMonitor);
  return resources.map(compact);
}
