import { redactSecrets } from '@monox/cloudapter-core';
import { validateDeploymentSpecV2 } from '@monox/deploy-schema';

const secretLikeName =
  /(?:^|_)(?:access_?key|api_?key|authorization|client_?secret|credential|password|private_?key|secret|secret_?key|token)(?:$|_)/i;
const secretValuePatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{20,}\b/,
];

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function id(value, fallback = 'app') {
  const normalized = String(value ?? fallback)
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return /^[a-z]/.test(normalized) ? normalized : `app-${normalized}`.slice(0, 63);
}

function quantity(value, fallback) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && value > 0) return String(value);
  return fallback;
}

function storageQuantity(value, fallback) {
  if (typeof value !== 'string' || value.length === 0) return quantity(value, fallback);
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti)$/);
  if (!match || !match[1].includes('.')) return value;
  const unitInKi = { Ki: 1, Mi: 1024, Gi: 1024 ** 2, Ti: 1024 ** 3 };
  return `${Math.ceil(Number(match[1]) * unitInKi[match[2]])}Ki`;
}

function defined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function number(value, fallback) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : fallback;
}

function positiveNumber(value) {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : undefined;
}

function command(value, fallback = ['node', '.']) {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  return fallback;
}

function probe(path, port = 'http') {
  return { type: 'http', path: path || '/healthz', port };
}

function v1Metric(autoscaling) {
  if (autoscaling?.mode === 'keda') {
    const trigger = autoscaling.keda?.triggers?.[0];
    if (trigger)
      return {
        type: 'keda',
        target: Number(trigger.metadata?.threshold ?? 1),
        scaler: trigger.type,
        metadata: trigger.metadata ?? {},
        authenticationRef: trigger.authenticationRef,
      };
  }
  if (autoscaling?.cpuUtilization) return { type: 'cpu', target: autoscaling.cpuUtilization };
  if (autoscaling?.memoryUtilization) return { type: 'memory', target: autoscaling.memoryUtilization };
  return null;
}

function baseReport(sourceFormat, input) {
  return {
    schemaVersion: '1',
    kind: 'MonoXMigrationReport',
    sourceFormat,
    targetVersion: '2',
    inputSummary: {
      keys: object(input) ? Object.keys(input).sort() : [],
    },
    changes: [],
    warnings: [],
    manualReview: [],
  };
}

function securityFindings(value, path = '$', key = '') {
  const findings = [];
  if (typeof value === 'string') {
    if (
      (secretLikeName.test(key) && !/ref|reference|name|id/i.test(key)) ||
      secretValuePatterns.some((pattern) => pattern.test(value))
    )
      findings.push({
        path,
        reason: 'secret-like value was not migrated',
        code: 'security',
      });
    return findings;
  }
  if (Array.isArray(value))
    return value.flatMap((item, index) => securityFindings(item, `${path}[${index}]`, key));
  if (object(value)) {
    for (const [childKey, item] of Object.entries(value))
      findings.push(...securityFindings(item, `${path}.${childKey}`, childKey));
  }
  return findings;
}

function finish(report, output) {
  const validation = validateDeploymentSpecV2(output);
  if (!validation.valid) {
    report.manualReview.push(
      ...validation.errors.map((issue) => ({
        path: issue.path,
        reason: issue.message,
        code: issue.code,
      }))
    );
  }
  report.manualReview.push(...securityFindings(output));
  report.manualReview = Array.from(
    new Map(
      report.manualReview.map((finding) => [
        `${finding.path}\u0000${finding.code}\u0000${finding.reason}`,
        finding,
      ])
    ).values()
  );
  const result = redactSecrets({ ...report, output });
  restoreSafeIdentityBooleans(result.output, output);
  return result;
}

function restoreSafeIdentityBooleans(redacted, source) {
  if (Array.isArray(source)) {
    source.forEach((item, index) => restoreSafeIdentityBooleans(redacted?.[index], item));
    return;
  }
  if (!object(source) || !object(redacted)) return;
  if (source.automountServiceAccountToken === false) redacted.automountServiceAccountToken = false;
  for (const [key, value] of Object.entries(source)) restoreSafeIdentityBooleans(redacted[key], value);
}

export function migrateV1Deployment(input, options = {}) {
  const report = baseReport('monox-v1', input);
  report.manualReview.push(...securityFindings(input));
  const name = id(options.id ?? input.name);
  const port = input.container?.port ?? options.port ?? 3000;
  const metric = v1Metric(input.autoscaling);
  const mode = input.autoscaling?.mode ?? 'none';
  const envValues = Object.fromEntries(
    (input.container?.env ?? [])
      .filter((entry) => !secretLikeName.test(entry.name))
      .map((entry) => [entry.name, entry.value])
  );
  const rejectedEnv = (input.container?.env ?? []).filter((entry) => secretLikeName.test(entry.name));
  if (rejectedEnv.length) {
    report.manualReview.push({
      path: '$.container.env',
      reason: 'secret-like inline environment values must move to external secret references',
      code: 'security',
    });
  }
  const output = {
    schemaVersion: '2',
    enabled: true,
    id: name,
    kind: options.kind ?? 'service',
    build: {
      strategy: 'dockerfile',
      context: options.context ?? '.',
      dockerfile: options.dockerfile ?? 'Dockerfile',
      image: input.image ? { repository: input.image.repository, tag: input.image.tag } : undefined,
    },
    runtime: {
      language: options.language ?? 'javascript',
      command: command(input.container?.command, options.command),
    },
    network: {
      exposure: input.ingress?.enabled ? 'public' : input.service?.enabled ? 'internal' : 'none',
      ports: input.service?.enabled
        ? [
            {
              name: 'http',
              containerPort: port,
              servicePort: input.service.port,
              protocol: 'TCP',
            },
          ]
        : [],
      routes: input.ingress?.enabled
        ? [
            {
              host: input.ingress.host,
              path: input.ingress.path ?? '/',
              pathType: input.ingress.pathType,
              tlsSecretRef: input.ingress.tls?.secretName,
            },
          ]
        : [],
    },
    probes: {
      startup: probe(input.probes?.startup?.path),
      readiness: probe(input.probes?.readiness?.path),
      liveness: probe(input.probes?.liveness?.path),
    },
    env: {
      values: envValues,
      secretRefs: (input.container?.envFromSecrets ?? []).map((secretName) => ({ name: secretName })),
    },
    resources: {
      requests: input.resources?.requests ?? { cpu: '100m', memory: '128Mi' },
      limits: input.resources?.limits ?? { cpu: '500m', memory: '512Mi' },
      accelerators: [],
    },
    identity: {
      serviceAccount: input.serviceAccount?.name,
      automountServiceAccountToken: false,
    },
    lifecycle: {
      terminationGracePeriodSeconds: input.terminationGracePeriodSeconds ?? 60,
      preStopCommand: [],
      drain: { enabled: false, timeoutSeconds: 30 },
    },
    scaling: {
      mode,
      minReplicas: mode === 'none' ? 1 : input.autoscaling.minReplicas,
      maxReplicas: mode === 'none' ? 1 : input.autoscaling.maxReplicas,
      metrics: metric ? [metric] : [],
    },
    variants: {},
    environments: {},
    adapterOverrides: {
      kubernetes: {
        namespace: input.namespace,
        serviceAccountName: input.serviceAccount?.name,
      },
    },
  };
  report.changes.push(
    { from: '$.name', to: '$.id', action: 'renamed' },
    { from: '$.container', to: '$.runtime and $.env', action: 'split' },
    { from: '$.service and $.ingress', to: '$.network', action: 'combined' },
    { from: '$.autoscaling', to: '$.scaling.metrics', action: 'typed' }
  );
  report.warnings.push('Review runtime.command and build paths before applying the migrated workload.');
  return finish(report, output);
}

function compact(value) {
  if (Array.isArray(value)) return value.map((item) => compact(item));
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, compact(item)])
  );
}

function addManual(report, path, reason, code = 'manual') {
  report.manualReview.push({ path, reason, code });
}

function addChange(report, from, to, action) {
  report.changes.push({ from, to, action });
}

function legacyKind(input) {
  const serviceClass = String(input.serviceClass ?? input.service_class ?? '').toLowerCase();
  if (['background-worker', 'singleton-worker'].includes(serviceClass)) return 'worker';
  const candidate = String(input.kind ?? input.type ?? input.deployment_type ?? '').toLowerCase();
  if (candidate.includes('worker') || candidate.includes('queue')) return 'worker';
  if (candidate.includes('cron')) return 'cron';
  if (candidate.includes('job')) return 'job';
  if (candidate.includes('model') || candidate.includes('gpu')) return 'model';
  if (
    ['cdn', 'website'].includes(candidate) ||
    candidate.includes('static') ||
    candidate.includes('frontend')
  )
    return 'static';
  return 'service';
}

function legacyLanguage(input) {
  const candidate = String(input.language ?? input.type ?? input.runtime ?? '').toLowerCase();
  if (candidate.includes('python')) return 'python';
  if (candidate.includes('php')) return 'php';
  if (candidate.includes('go')) return 'go';
  if (candidate.includes('typescript')) return 'typescript';
  return 'javascript';
}

function defaultCommand(language, kind) {
  if (kind === 'static') return ['static'];
  if (language === 'python') return ['python', '-m', 'app'];
  if (language === 'php') return ['php', '-S', '0.0.0.0:8080', '-t', 'public'];
  if (language === 'go') return ['./app'];
  return ['node', '.'];
}

function legacyProbe(path, settings, { partial = false, fallbackPath = '/healthz' } = {}) {
  if (partial && path === undefined && !object(settings)) return undefined;
  const result = {
    type: 'http',
    path: path ?? (partial ? undefined : fallbackPath),
    port: 'http',
    delaySeconds: settings?.initialDelaySeconds ?? settings?.delaySeconds,
    periodSeconds: settings?.periodSeconds,
    timeoutSeconds: settings?.timeoutSeconds,
    failureThreshold: settings?.failureThreshold,
    successThreshold: settings?.successThreshold,
  };
  return compact(result);
}

function legacyProbes(input, { partial = false, exposed = true } = {}) {
  if (!exposed && !partial) return {};
  const grouped = object(input.probes) ? input.probes : {};
  const startup = legacyProbe(
    defined(input.startupHealthRoute, input.startup_health_route, input.startup_path),
    defined(input.startupProbe, grouped.startup),
    { partial, fallbackPath: '/healthz' }
  );
  const readiness = legacyProbe(
    defined(input.healthRoute, input.readinessHealthRoute, input.readiness_path, input.health_path),
    defined(input.readinessProbe, grouped.readiness),
    { partial, fallbackPath: '/readyz' }
  );
  const liveness = legacyProbe(
    defined(input.livenessHealthRoute, input.liveness_health_route, input.liveness_path, input.health_path),
    defined(input.livenessProbe, grouped.liveness),
    { partial, fallbackPath: '/healthz' }
  );
  return compact({ startup, readiness, liveness });
}

function legacyExecProbe(value) {
  if (!object(value) || !Array.isArray(value.command) || value.command.length === 0) return undefined;
  return compact({
    type: 'exec',
    command: value.command,
    delaySeconds: value.initialDelaySeconds ?? value.delaySeconds,
    periodSeconds: value.periodSeconds,
    timeoutSeconds: value.timeoutSeconds,
    failureThreshold: value.failureThreshold,
    successThreshold: value.successThreshold,
  });
}

function legacyWorkerProbes(input) {
  const grouped = object(input.probes) ? input.probes : {};
  return compact({
    startup: legacyExecProbe(grouped.startup),
    readiness: legacyExecProbe(grouped.readiness),
    liveness: legacyExecProbe(grouped.liveness),
  });
}

function reviewWorkerLifecycle(input, output, report) {
  if (output.kind !== 'worker') return;
  const strictProbes = Boolean(output.probes?.readiness && output.probes?.liveness);
  const boundedDrain =
    output.lifecycle?.drain?.enabled === true &&
    Array.isArray(output.lifecycle.preStopCommand) &&
    output.lifecycle.preStopCommand.length > 0;
  if (!strictProbes || !boundedDrain)
    addManual(
      report,
      '$.lifecycle',
      'worker requires verified exec readiness and liveness probes plus a bounded drain preStop command',
      'worker-lifecycle'
    );
}

function legacyResources(input, { partial = false, accelerators = [] } = {}) {
  const resources = object(input.resources) ? input.resources : {};
  const requests = compact({
    cpu: quantity(
      defined(input.cpu_request, resources.requests?.cpu, resources.cpu?.request),
      partial ? undefined : '100m'
    ),
    memory: storageQuantity(
      defined(input.memory_request, resources.requests?.memory, resources.mem?.request),
      partial ? undefined : '128Mi'
    ),
    ephemeralStorage: storageQuantity(
      defined(input.ephemeral_storage_request, resources.requests?.ephemeralStorage),
      undefined
    ),
  });
  const limits = compact({
    cpu: quantity(
      defined(input.cpu_limit, resources.limits?.cpu, resources.cpu?.limit),
      partial ? undefined : '500m'
    ),
    memory: storageQuantity(
      defined(input.memory_limit, resources.limits?.memory, resources.mem?.limit),
      partial ? undefined : '512Mi'
    ),
    ephemeralStorage: storageQuantity(
      defined(input.ephemeral_storage_limit, resources.limits?.ephemeralStorage),
      undefined
    ),
  });
  if (partial && Object.keys(requests).length === 0 && Object.keys(limits).length === 0) return undefined;
  if (partial)
    return compact({
      requests: Object.keys(requests).length > 0 ? requests : undefined,
      limits: Object.keys(limits).length > 0 ? limits : undefined,
    });
  return { requests, limits, accelerators };
}

function isSecretValue(value) {
  return typeof value === 'string' && secretValuePatterns.some((pattern) => pattern.test(value));
}

function legacyEnvValues(input, report, path) {
  if (!object(input)) return {};
  const values = {};
  for (const [name, value] of Object.entries(input)) {
    if (secretLikeName.test(name) || isSecretValue(value)) {
      addManual(
        report,
        `${path}.${name}`,
        'inline secret-like environment value must move to env.secretRefs',
        'security'
      );
      continue;
    }
    if (['string', 'number', 'boolean'].includes(typeof value)) values[name] = String(value);
    else
      addManual(
        report,
        `${path}.${name}`,
        'non-scalar environment value requires manual conversion',
        'unmapped'
      );
  }
  return values;
}

function reviewScalingControls(hpa, report, path) {
  if (!object(hpa)) return;
  for (const key of ['polling_interval', 'cooldown_period']) {
    if (hpa[key] !== undefined)
      addManual(
        report,
        `${path}.${key}`,
        'legacy KEDA timing is not represented by deployment v2 and must be reviewed',
        'scaling-timing'
      );
  }
  if (hpa.activation_rps !== undefined)
    addManual(
      report,
      `${path}.activation_rps`,
      'RPS activation threshold requires an explicit metric-source migration',
      'scaling-activation'
    );
  if (hpa.enable_cold_deploy === true)
    addManual(
      report,
      `${path}.enable_cold_deploy`,
      'cold-deploy reactivation must become an explicit suspended or scale-to-zero workflow',
      'hidden-unpause'
    );
}

function legacyScaling(input, report, path = '$', { partial = false } = {}) {
  const hpa = object(input.hpa) ? input.hpa : {};
  reviewScalingControls(hpa, report, `${path}.hpa`);

  const queue = defined(input.queue, input.queue_name, input.rabbitmq_queue, hpa.queue_name);
  const rps = positiveNumber(defined(input.rps, input.requests_per_second, hpa.requests_per_second, hpa.rps));
  const queueTarget = positiveNumber(
    defined(input.queue_length, input.messages_per_replica, hpa.average_value, 10)
  );
  const queueOnly = hpa.scale_only_on_queue === true;
  const cpu = queueOnly
    ? undefined
    : positiveNumber(defined(input.cpu_target, input.cpuTarget, hpa.cpu?.utilization, hpa.cpu));
  const memory = queueOnly
    ? undefined
    : positiveNumber(
        defined(input.memory_target, input.memoryTarget, hpa.mem?.utilization, hpa.memory?.utilization)
      );
  const metrics = [];
  if (cpu !== undefined) metrics.push({ type: 'cpu', target: cpu });
  if (memory !== undefined) metrics.push({ type: 'memory', target: memory });
  if (queue !== undefined && String(queue).length > 0) {
    const activationValue = positiveNumber(hpa.activation_value);
    metrics.push(
      compact({
        type: 'rabbitmq',
        target: queueTarget,
        sourceRef: 'RABBITMQ_URL',
        queue: String(queue),
        metadata: activationValue === undefined ? undefined : { activationValue: String(activationValue) },
      })
    );
    addManual(
      report,
      `${path}.hpa.queue_name`,
      'bind RABBITMQ_URL to an external secret reference before applying the migrated workload',
      'secret-binding'
    );
  }
  if (rps !== undefined && hpa.enable_rps_scaling !== false) {
    metrics.push({
      type: 'rps',
      target: rps,
      sourceRef: 'REVIEW_REQUIRED',
      query: 'REVIEW_REQUIRED',
      metricName: 'service_rps',
    });
    addManual(
      report,
      `${path}.hpa.requests_per_second`,
      'bind an explicit metric source and workload-specific RPS query',
      'metric-source'
    );
  }

  const replica = defined(input.replicas, input.replicaCount);
  let minReplicas = number(
    defined(input.replicas_min, input.min_replicas, input.minReplicas, hpa.min, replica),
    partial ? undefined : 1
  );
  let maxReplicas = number(
    defined(input.replicas_max, input.max_replicas, input.maxReplicas, hpa.max, replica),
    partial ? undefined : 1
  );
  const suspended = maxReplicas === 0 || input.suspended === true;
  if (suspended) {
    minReplicas = 1;
    maxReplicas = 1;
    addChange(report, `${path}.maxReplicas`, `${path}.suspended`, 'replaced');
  }

  const externalMetric = metrics.some((metric) => !['cpu', 'memory'].includes(metric.type));
  if (!suspended && minReplicas === 0 && !externalMetric) {
    minReplicas = 1;
    addManual(
      report,
      `${path}.replicas_min`,
      'scale to zero requires an external metric; minimum replicas was raised to one',
      'scaling-safety'
    );
  }
  const mode = suspended || metrics.length === 0 ? 'none' : externalMetric ? 'keda' : 'hpa';
  const behavior = compact({
    scaleUpStabilizationSeconds: number(hpa.scale_up_stabilization_window, undefined),
    scaleDownStabilizationSeconds: number(hpa.scale_down_stabilization_window, undefined),
  });
  const hasReplicaConfiguration = [
    input.replicas,
    input.replicaCount,
    input.replicas_min,
    input.min_replicas,
    input.minReplicas,
    input.replicas_max,
    input.max_replicas,
    input.maxReplicas,
    input.suspended,
  ].some((value) => value !== undefined);
  if (partial && !hasReplicaConfiguration && metrics.length === 0 && Object.keys(behavior).length === 0)
    return { value: undefined, suspended: false, needsRabbitMqSecret: false };
  return {
    value: compact({
      mode: partial && !suspended && metrics.length === 0 ? undefined : mode,
      minReplicas,
      maxReplicas,
      metrics: suspended ? [] : metrics.length > 0 ? metrics : partial ? undefined : [],
      behavior: Object.keys(behavior).length > 0 ? behavior : undefined,
    }),
    suspended,
    needsRabbitMqSecret: metrics.some((metric) => metric.type === 'rabbitmq'),
  };
}

function telemetryPatch(input, report, path) {
  if (!object(input.metrics)) return undefined;
  for (const key of ['interval', 'scrapeTimeout']) {
    if (input.metrics[key] !== undefined)
      addManual(
        report,
        `${path}.metrics.${key}`,
        'scrape timing belongs in the target observability configuration',
        'telemetry-target'
      );
  }
  return {
    metrics: compact({
      enabled: input.metrics.enabled === true,
      path: input.metrics.path,
      port: Number.isInteger(input.metrics.port) ? input.metrics.port : undefined,
    }),
  };
}

function environmentName(name) {
  if (name === 'prod') return 'production';
  if (name === 'stg') return 'staging';
  return id(name, 'environment');
}

function legacyPatch(input, report, path) {
  if (!object(input)) return {};
  const scaling = legacyScaling(input, report, path, { partial: true });
  const resources = legacyResources(input, { partial: true });
  const probes = legacyProbes(input, { partial: true });
  const values = legacyEnvValues(input.env, report, `${path}.env`);
  const secretRefs = scaling.needsRabbitMqSecret
    ? [{ name: 'rabbitmq-connection', target: 'RABBITMQ_URL' }]
    : [];
  const telemetry = telemetryPatch(input, report, path);
  if (input.resources?.storage !== undefined)
    addManual(
      report,
      `${path}.resources.storage`,
      'persistent storage needs an explicit mount path, class and lifecycle policy',
      'storage'
    );
  for (const key of ['priorityClassName', 'placementProfile']) {
    if (input[key] !== undefined)
      addManual(
        report,
        `${path}.${key}`,
        'placement policy must move to a root workload profile or target binding',
        'placement'
      );
  }
  return compact({
    suspended: scaling.suspended ? true : undefined,
    probes: Object.keys(probes).length > 0 ? probes : undefined,
    env: Object.keys(values).length > 0 || secretRefs.length > 0 ? { values, secretRefs } : undefined,
    resources,
    telemetry,
    lifecycle:
      input.terminationGracePeriodSeconds !== undefined || input.termination_grace_period !== undefined
        ? {
            terminationGracePeriodSeconds: number(
              defined(input.terminationGracePeriodSeconds, input.termination_grace_period),
              undefined
            ),
          }
        : undefined,
    scaling: scaling.value,
  });
}

function legacyVariant(value, report, path) {
  if (!object(value)) return {};
  const patch = legacyPatch(value, report, path);
  const paths = Array.isArray(value.ingress?.paths)
    ? value.ingress.paths.filter((item) => typeof item === 'string' && item.startsWith('/'))
    : [];
  if (paths.length > 0)
    patch.network = { exposure: 'public', routes: paths.map((routePath) => ({ path: routePath })) };
  if (object(value.pdb))
    addManual(
      report,
      `${path}.pdb`,
      'variant-specific disruption budget requires a semantic diff against secure renderer defaults',
      'pdb'
    );
  return patch;
}

function collectLegacyVariants(input, report) {
  const variants = {};
  const base = input.sideDeployments ?? input.side_deployments;
  const baseEntries = Array.isArray(base)
    ? base.map((item, index) => [id(item?.name, `variant-${index + 1}`), item])
    : object(base)
      ? Object.entries(base)
      : [];
  for (const [name, value] of baseEntries)
    variants[id(name, 'variant')] = legacyVariant(value, report, `$.sideDeployments.${id(name, 'variant')}`);

  for (const [legacyName, environment] of Object.entries(input.environments ?? {})) {
    if (!object(environment) || !Array.isArray(environment.sideDeployments)) continue;
    const targetEnvironment = environmentName(legacyName);
    environment.sideDeployments.forEach((variant, index) => {
      const variantId = id(variant?.name, `variant-${index + 1}`);
      variants[variantId] ??= {};
      variants[variantId].environments ??= {};
      variants[variantId].environments[targetEnvironment] = legacyVariant(
        variant,
        report,
        `$.environments.${legacyName}.sideDeployments.${variantId}`
      );
    });
  }
  if (Object.keys(variants).length > 0)
    addManual(
      report,
      '$.sideDeployments',
      'variants were mapped structurally and require a sanitized dual-render semantic diff',
      'semantic-diff'
    );
  return variants;
}

function collectLegacyEnvironments(input, report) {
  const environments = {};
  for (const [legacyName, value] of Object.entries(input.environments ?? {})) {
    if (!object(value)) {
      addManual(report, `$.environments.${legacyName}`, 'environment patch must be an object', 'unmapped');
      continue;
    }
    const patch = legacyPatch(value, report, `$.environments.${legacyName}`);
    if (Object.keys(patch).length > 0) environments[environmentName(legacyName)] = patch;
    if (legacyName !== environmentName(legacyName))
      addChange(
        report,
        `$.environments.${legacyName}`,
        `$.environments.${environmentName(legacyName)}`,
        'renamed'
      );
  }
  return environments;
}

function unsafeBehaviorFindings(value, path = '$') {
  const findings = [];
  if (Array.isArray(value))
    return value.flatMap((item, index) => unsafeBehaviorFindings(item, `${path}[${index}]`));
  if (!object(value)) return findings;
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    const normalized = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
    if (normalized === 'allowpodselfpatch')
      findings.push({
        path: itemPath,
        reason: 'pod self-patching requires redesign without broad runtime RBAC',
        code: 'privileged-self-patch',
      });
    else if (normalized.includes('unpause') || normalized === 'enablecolddeploy')
      findings.push({
        path: itemPath,
        reason: 'hidden reactivation must become an explicit suspended or scale-to-zero workflow',
        code: 'hidden-unpause',
      });
    else if (
      ['kubernetespatch', 'k8spatch', 'podpatch', 'rawmanifest', 'rawmanifests'].includes(normalized) ||
      /^(?:extra)?(?:kubernetes|k8s)?patches$/.test(normalized)
    )
      findings.push({
        path: itemPath,
        reason: 'arbitrary platform patches are not accepted by the constrained v2 adapter schema',
        code: 'arbitrary-patch',
      });
    findings.push(...unsafeBehaviorFindings(item, itemPath));
  }
  return findings;
}

function targetBindingReviews(input, report) {
  const fields = [
    ['target', 'target selection'],
    ['host', 'target-derived host or domain'],
    ['domain', 'target-derived domain'],
    ['bucket', 'static bucket'],
    ['cloudfrontId', 'CDN identifier'],
    ['providers', 'provider-specific static configuration'],
    ['workload_identity', 'provider workload identity'],
    ['workloadIdentity', 'provider workload identity'],
  ];
  for (const [field, label] of fields) {
    if (input[field] === undefined) continue;
    addManual(
      report,
      `$.${field}`,
      `${label} must move to exactly one root target binding and was not copied into the package`,
      'target-binding'
    );
  }
  if (fields.some(([field]) => input[field] !== undefined))
    addChange(report, 'legacy provider and target fields', 'monox.config.json $.targets', 'extract');
}

export function migrateLegacyDeployment(input, options = {}) {
  const report = baseReport('legacy-production', input);
  report.manualReview.push(...securityFindings(input));
  report.manualReview.push(...unsafeBehaviorFindings(input));
  const workloadId = id(options.id ?? input.id ?? input.name ?? input.app_name ?? input.slug);
  const kind = options.kind ?? legacyKind(input);
  const language = options.language ?? legacyLanguage(input);
  const workloadPort = number(defined(input.port, input.container_port), 3000);
  const serviceClass = String(input.serviceClass ?? input.service_class ?? '').toLowerCase();
  const noNetwork = ['worker', 'cron', 'job'].includes(kind);
  const explicitlyPublic =
    input.public === true ||
    Boolean(input.ingress) ||
    typeof input.domain === 'string' ||
    serviceClass === 'critical-public';
  const exposure = noNetwork ? 'none' : explicitlyPublic ? 'public' : kind === 'static' ? 'none' : 'internal';
  const gpuEnabled = object(input.gpu) ? input.gpu.enabled !== false : true;
  const gpuCount = number(
    defined(input.gpu?.count, input.gpu_count, object(input.gpu) ? undefined : input.gpu),
    0
  );
  const accelerators =
    gpuEnabled && Number.isInteger(gpuCount) && gpuCount > 0
      ? [{ type: 'nvidia.com/gpu', count: gpuCount, model: input.gpu?.model ?? input.gpu_model }]
      : [];
  const scaling = legacyScaling(input, report);
  const envValues = legacyEnvValues(input.env, report, '$.env');
  const envSecretRefs = scaling.needsRabbitMqSecret
    ? [{ name: 'rabbitmq-connection', target: 'RABBITMQ_URL' }]
    : [];
  const variants = collectLegacyVariants(input, report);
  const environments = collectLegacyEnvironments(input, report);
  const telemetry = telemetryPatch(input, report, '$');
  const output = compact({
    schemaVersion: '2',
    enabled: input.enabled !== false,
    id: workloadId,
    kind,
    suspended: scaling.suspended || input.suspended === true,
    labels:
      serviceClass.length > 0
        ? {
            'monox.dev/service-class': serviceClass,
          }
        : {},
    build: {
      strategy: kind === 'static' ? 'static' : 'dockerfile',
      context: input.context ?? input.docker_context ?? '.',
      dockerfile: kind === 'static' ? undefined : (input.dockerfile ?? input.docker_file ?? 'Dockerfile'),
      output: kind === 'static' ? (input.output ?? input.dist ?? input.source ?? 'dist') : undefined,
    },
    runtime: {
      language,
      framework: input.framework,
      command: command(
        input.command ?? input.start,
        command(options.command, defaultCommand(language, kind))
      ),
      workingDirectory: input.workingDirectory ?? input.working_directory,
      cron: kind === 'cron' ? (input.cron ?? input.schedule) : undefined,
      tuning:
        input.resources?.nodeHeapMb === undefined
          ? undefined
          : { nodeHeapMb: String(input.resources.nodeHeapMb) },
    },
    network: {
      exposure,
      ports:
        exposure === 'none'
          ? []
          : [
              {
                name: 'http',
                containerPort: workloadPort,
                servicePort: number(defined(input.externalPort, input.service_port), 80),
              },
            ],
      routes: exposure === 'public' ? [{ path: input.path ?? '/' }] : [],
    },
    probes:
      kind === 'worker'
        ? legacyWorkerProbes(input)
        : ['service', 'model'].includes(kind)
          ? legacyProbes(input, { exposed: exposure !== 'none' })
          : {},
    env: { values: envValues, secretRefs: envSecretRefs },
    resources: legacyResources(input, { accelerators }),
    storage: [],
    identity: {
      serviceAccount:
        typeof defined(input.service_account, input.serviceAccount) === 'string'
          ? defined(input.service_account, input.serviceAccount)
          : undefined,
      automountServiceAccountToken: false,
    },
    telemetry,
    lifecycle: {
      terminationGracePeriodSeconds: number(
        defined(input.terminationGracePeriodSeconds, input.termination_grace_period),
        60
      ),
      preStopCommand: command(input.pre_stop, []),
      drain: {
        enabled: Boolean(input.drain ?? kind === 'worker'),
        timeoutSeconds: number(input.drain_timeout, 30),
      },
    },
    scaling: scaling.value,
    variants,
    environments,
    adapterOverrides: {},
  });
  report.changes.push(
    { from: 'legacy replica fields', to: '$.scaling', action: 'typed' },
    { from: 'legacy HPA fields', to: '$.scaling.metrics', action: 'typed' },
    { from: 'sideDeployments', to: '$.variants', action: 'renamed' },
    { from: 'GPU fields', to: '$.resources.accelerators', action: 'normalized' }
  );
  if (typeof input.command === 'string' || typeof input.start === 'string')
    addManual(
      report,
      typeof input.command === 'string' ? '$.command' : '$.start',
      'convert the legacy shell string to an explicit argv array',
      'manual'
    );
  if (input.resources?.storage !== undefined)
    addManual(
      report,
      '$.resources.storage',
      'persistent storage needs an explicit mount path, class and lifecycle policy',
      'storage'
    );
  reviewWorkerLifecycle(input, output, report);
  for (const key of ['priorityClassName', 'placementProfile']) {
    if (input[key] !== undefined)
      addManual(
        report,
        `$.${key}`,
        'placement policy must move to a root workload profile or target binding',
        'placement'
      );
  }
  targetBindingReviews(input, report);
  const mappedKeys = new Set([
    '_terminationGracePeriodSecondsNote',
    'schemaVersion',
    'enabled',
    'id',
    'name',
    'app_name',
    'slug',
    'kind',
    'type',
    'deployment_type',
    'serviceClass',
    'service_class',
    'language',
    'runtime',
    'framework',
    'context',
    'docker_context',
    'dockerfile',
    'docker_file',
    'output',
    'dist',
    'command',
    'start',
    'workingDirectory',
    'working_directory',
    'cron',
    'schedule',
    'port',
    'externalPort',
    'container_port',
    'public',
    'ingress',
    'domain',
    'path',
    'service_port',
    'host',
    'target',
    'bucket',
    'cloudfrontId',
    'providers',
    'source',
    'startupHealthRoute',
    'startup_health_route',
    'healthRoute',
    'readinessHealthRoute',
    'livenessHealthRoute',
    'liveness_health_route',
    'startupProbe',
    'readinessProbe',
    'livenessProbe',
    'probes',
    'health_path',
    'healthcheck',
    'readiness_path',
    'liveness_path',
    'cpu_request',
    'memory_request',
    'cpu_limit',
    'memory_limit',
    'resources',
    'ephemeral_storage_request',
    'ephemeral_storage_limit',
    'gpu',
    'gpu_count',
    'gpu_model',
    'service_account',
    'serviceAccount',
    'workload_identity',
    'workloadIdentity',
    'terminationGracePeriodSeconds',
    'termination_grace_period',
    'pre_stop',
    'drain',
    'drain_timeout',
    'replicas_min',
    'min_replicas',
    'minReplicas',
    'replicas_max',
    'max_replicas',
    'maxReplicas',
    'replicas',
    'replicaCount',
    'hpa',
    'queue',
    'queue_name',
    'rabbitmq_queue',
    'queue_length',
    'messages_per_replica',
    'rps',
    'requests_per_second',
    'cpu_target',
    'cpuTarget',
    'memory_target',
    'memoryTarget',
    'keda',
    'sideDeployments',
    'side_deployments',
    'suspended',
    'environments',
    'env',
    'metrics',
    'priorityClassName',
    'placementProfile',
    'allow_pod_self_patch',
    'allowPodSelfPatch',
    'kubernetes_patch',
    'kubernetesPatch',
    'k8sPatch',
    'podPatch',
    'raw_manifest',
    'rawManifest',
    'rawManifests',
    'patches',
    'unpause',
    'unpauseAfterDeploy',
  ]);
  for (const key of Object.keys(input)) {
    if (key.startsWith('_')) {
      report.warnings.push(`Legacy note ${key} was intentionally not migrated.`);
      continue;
    }
    if (!mappedKeys.has(key) && !secretLikeName.test(key))
      addManual(
        report,
        `$.${key}`,
        'legacy field is not mapped and must be reviewed before write mode',
        'unmapped'
      );
  }
  report.warnings.push('Legacy migration is a report, not an apply operation. Review every manual item.');
  return finish(report, output);
}

export function migrateDeployment(input, { from, ...options } = {}) {
  if (from === 'monox-v1') return migrateV1Deployment(input, options);
  if (from === 'legacy-production') return migrateLegacyDeployment(input, options);
  throw new TypeError('Migration source must be monox-v1 or legacy-production');
}
