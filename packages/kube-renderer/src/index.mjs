import { assertValidDeploymentConfig } from '@monox/deploy-schema';

import { renderYamlDocuments } from './yaml.mjs';

function compactObject(value) {
  if (Array.isArray(value)) return value.map(compactObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, compactObject(item)])
  );
}

function metadata(config, suffix = '', additions = {}) {
  return compactObject({
    name: suffix ? `${config.name}-${suffix}` : config.name,
    namespace: config.namespace,
    labels: {
      ...config.labels,
      'app.kubernetes.io/name': config.name,
      'app.kubernetes.io/instance': config.name,
      'app.kubernetes.io/managed-by': 'monox',
      ...additions.labels,
    },
    annotations: {
      ...config.annotations,
      ...additions.annotations,
    },
  });
}

function selectorLabels(config) {
  return {
    'app.kubernetes.io/name': config.name,
    'app.kubernetes.io/instance': config.name,
  };
}

function probe(value) {
  return {
    httpGet: {
      path: value.path,
      port: 'http',
      scheme: 'HTTP',
    },
    initialDelaySeconds: value.initialDelaySeconds,
    periodSeconds: value.periodSeconds,
    timeoutSeconds: value.timeoutSeconds,
    failureThreshold: value.failureThreshold,
    successThreshold: value.successThreshold,
  };
}

function namespaceResource(config) {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: config.namespace,
      labels: {
        'app.kubernetes.io/part-of': config.name,
        'app.kubernetes.io/managed-by': 'monox',
      },
    },
  };
}

function serviceAccountResource(config) {
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: {
      ...metadata(config),
      name: config.serviceAccount.name,
      annotations: config.serviceAccount.annotations,
    },
    automountServiceAccountToken: false,
  };
}

function topologySpreadConstraints(config) {
  if (!config.topologySpread.enabled) return undefined;
  return config.topologySpread.topologyKeys.map((topologyKey) => ({
    maxSkew: config.topologySpread.maxSkew,
    topologyKey,
    whenUnsatisfiable: config.topologySpread.whenUnsatisfiable,
    labelSelector: { matchLabels: selectorLabels(config) },
  }));
}

function deploymentResource(config) {
  const container = compactObject({
    name: config.name,
    image: `${config.image.repository}:${config.image.tag}`,
    imagePullPolicy: config.image.pullPolicy,
    command: config.container.command.length > 0 ? config.container.command : undefined,
    args: config.container.args.length > 0 ? config.container.args : undefined,
    ports: [
      {
        name: 'http',
        containerPort: config.container.port,
        protocol: 'TCP',
      },
    ],
    env: config.container.env.length > 0 ? config.container.env : undefined,
    envFrom:
      config.container.envFromSecrets.length > 0
        ? config.container.envFromSecrets.map((name) => ({ secretRef: { name } }))
        : undefined,
    startupProbe: probe(config.probes.startup),
    readinessProbe: probe(config.probes.readiness),
    livenessProbe: probe(config.probes.liveness),
    resources: config.resources,
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
      readOnlyRootFilesystem: config.podSecurity.readOnlyRootFilesystem,
      runAsNonRoot: true,
      runAsUser: config.podSecurity.runAsUser,
      runAsGroup: config.podSecurity.runAsGroup,
    },
    volumeMounts: config.container.writableTmp ? [{ name: 'tmp', mountPath: '/tmp' }] : undefined,
  });

  const spec = compactObject({
    replicas: config.autoscaling.mode === 'none' ? config.replicas : undefined,
    revisionHistoryLimit: config.revisionHistoryLimit,
    strategy: {
      type: 'RollingUpdate',
      rollingUpdate: config.rollingUpdate,
    },
    selector: { matchLabels: selectorLabels(config) },
    template: {
      metadata: {
        labels: {
          ...config.labels,
          ...selectorLabels(config),
        },
        annotations: config.annotations,
      },
      spec: compactObject({
        serviceAccountName: config.serviceAccount.name,
        automountServiceAccountToken: false,
        terminationGracePeriodSeconds: config.terminationGracePeriodSeconds,
        imagePullSecrets:
          config.image.pullSecrets.length > 0
            ? config.image.pullSecrets.map((name) => ({ name }))
            : undefined,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: config.podSecurity.runAsUser,
          runAsGroup: config.podSecurity.runAsGroup,
          fsGroup: config.podSecurity.fsGroup,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        topologySpreadConstraints: topologySpreadConstraints(config),
        containers: [container],
        volumes: config.container.writableTmp
          ? [{ name: 'tmp', emptyDir: { sizeLimit: '256Mi' } }]
          : undefined,
      }),
    },
  });

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: metadata(config),
    spec,
  };
}

function serviceResource(config) {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: metadata(config, '', { annotations: config.service.annotations }),
    spec: {
      type: config.service.type,
      selector: selectorLabels(config),
      ports: [
        {
          name: 'http',
          port: config.service.port,
          targetPort: 'http',
          protocol: 'TCP',
        },
      ],
    },
  };
}

function ingressResource(config) {
  const ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: metadata(config, '', { annotations: config.ingress.annotations }),
    spec: compactObject({
      ingressClassName: config.ingress.className,
      rules: [
        {
          host: config.ingress.host,
          http: {
            paths: [
              {
                path: config.ingress.path,
                pathType: config.ingress.pathType,
                backend: {
                  service: {
                    name: config.name,
                    port: { number: config.service.port },
                  },
                },
              },
            ],
          },
        },
      ],
      tls: config.ingress.tls.enabled
        ? [{ hosts: [config.ingress.host], secretName: config.ingress.tls.secretName }]
        : undefined,
    }),
  };
  return ingress;
}

function podDisruptionBudgetResource(config) {
  return {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: metadata(config),
    spec: compactObject({
      minAvailable: config.podDisruptionBudget.minAvailable,
      maxUnavailable: config.podDisruptionBudget.maxUnavailable,
      selector: { matchLabels: selectorLabels(config) },
    }),
  };
}

function networkPeer(peer) {
  return compactObject({
    namespaceSelector: peer.namespaceLabels ? { matchLabels: peer.namespaceLabels } : undefined,
    podSelector: peer.podLabels ? { matchLabels: peer.podLabels } : undefined,
  });
}

function networkPolicyResource(config) {
  const egress = [];
  if (config.networkPolicy.egress.dns) {
    egress.push({
      to: [
        {
          namespaceSelector: {
            matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
          },
        },
      ],
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    });
  }
  if (config.networkPolicy.egress.https) egress.push({ ports: [{ protocol: 'TCP', port: 443 }] });
  if (config.networkPolicy.egress.sameNamespace) egress.push({ to: [{ podSelector: {} }] });

  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: metadata(config),
    spec: {
      podSelector: { matchLabels: selectorLabels(config) },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        {
          from: config.networkPolicy.ingressFrom.map(networkPeer),
          ports: [{ protocol: 'TCP', port: config.container.port }],
        },
      ],
      egress,
    },
  };
}

function hpaResource(config) {
  const metrics = [];
  if (config.autoscaling.cpuUtilization !== undefined) {
    metrics.push({
      type: 'Resource',
      resource: {
        name: 'cpu',
        target: { type: 'Utilization', averageUtilization: config.autoscaling.cpuUtilization },
      },
    });
  }
  if (config.autoscaling.memoryUtilization !== undefined) {
    metrics.push({
      type: 'Resource',
      resource: {
        name: 'memory',
        target: { type: 'Utilization', averageUtilization: config.autoscaling.memoryUtilization },
      },
    });
  }
  return {
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: metadata(config),
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: config.name },
      minReplicas: config.autoscaling.minReplicas,
      maxReplicas: config.autoscaling.maxReplicas,
      behavior: {
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
      },
      metrics,
    },
  };
}

function kedaResource(config) {
  return {
    apiVersion: 'keda.sh/v1alpha1',
    kind: 'ScaledObject',
    metadata: metadata(config),
    spec: {
      scaleTargetRef: { name: config.name },
      pollingInterval: config.autoscaling.keda.pollingInterval,
      cooldownPeriod: config.autoscaling.keda.cooldownPeriod,
      minReplicaCount: config.autoscaling.minReplicas,
      maxReplicaCount: config.autoscaling.maxReplicas,
      triggers: config.autoscaling.keda.triggers.map((trigger) =>
        compactObject({
          type: trigger.type,
          metadata: trigger.metadata,
          authenticationRef: trigger.authenticationRef ? { name: trigger.authenticationRef } : undefined,
        })
      ),
    },
  };
}

export function buildKubernetesResources(input) {
  const config = assertValidDeploymentConfig(input);
  const resources = [];
  if (config.createNamespace) resources.push(namespaceResource(config));
  if (config.serviceAccount.create) resources.push(serviceAccountResource(config));
  resources.push(deploymentResource(config));
  if (config.service.enabled) resources.push(serviceResource(config));
  if (config.ingress.enabled) resources.push(ingressResource(config));
  if (config.podDisruptionBudget.enabled) resources.push(podDisruptionBudgetResource(config));
  if (config.networkPolicy.enabled) resources.push(networkPolicyResource(config));
  if (config.autoscaling.mode === 'hpa') resources.push(hpaResource(config));
  if (config.autoscaling.mode === 'keda') resources.push(kedaResource(config));
  return resources;
}

export function renderKubernetesManifests(input) {
  return renderYamlDocuments(buildKubernetesResources(input));
}

export { renderYamlDocuments, toYaml } from './yaml.mjs';
