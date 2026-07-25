import {
  assertCloudapter,
  assertFreshPlan,
  createPlan,
  createReceipt,
  deterministicDigest,
} from '@monox/cloudapter-core';
import { assertValidDeploymentSpecV2 } from '@monox/deploy-schema';

function id(workload) {
  return workload.deployment?.id ?? workload.id;
}

function sorted(workloads = []) {
  return [...workloads].sort((left, right) => id(left).localeCompare(id(right)));
}

function stateDigest(context) {
  return (
    context.targetStateDigest ?? deterministicDigest({ target: context.target?.id, state: 'coolify-unknown' })
  );
}

function coolifyReferences(target) {
  return {
    serverRef: target.serverRef,
    projectRef: target.projectRef,
    destinationRef: target.clusterRef,
    tokenRef: target.bindings?.identityRef,
    environmentName: target.bindings?.namespace,
    domain: target.bindings?.domain,
  };
}

function image(deployment) {
  const candidate = deployment.build?.image;
  if (typeof candidate === 'string') return candidate;
  if (candidate?.repository && candidate?.tag && candidate.tag !== 'latest')
    return `${candidate.repository}:${candidate.tag}`;
  throw new TypeError(`${deployment.id} requires an immutable image for Coolify`);
}

function composeEnvironment(deployment) {
  const result = { ...deployment.env?.values };
  for (const reference of deployment.env?.secretRefs ?? []) {
    const name = reference.target ?? reference.name.replace(/-/g, '_').toUpperCase();
    result[name] = `\${${name}:?required}`;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function compose(workloads, target, name) {
  const references = coolifyReferences(target);
  const services = {};
  for (const workload of workloads) {
    const deployment = workload.deployment;
    const ports = deployment.network?.ports ?? [];
    services[deployment.id] = {
      image: image(deployment),
      command: deployment.runtime?.command,
      environment: composeEnvironment(deployment),
      expose: ports.map((port) => String(port.containerPort)),
      healthcheck: deployment.probes?.readiness
        ? {
            test: probeCommand(deployment.probes.readiness, deployment),
            interval: `${deployment.probes.readiness.periodSeconds ?? 10}s`,
            timeout: `${deployment.probes.readiness.timeoutSeconds ?? 3}s`,
            retries: deployment.probes.readiness.failureThreshold ?? 3,
          }
        : undefined,
      labels: coolifyLabels(deployment, references.domain),
    };
  }
  return { name, services };
}

function probeCommand(probe, deployment) {
  const port =
    typeof probe.port === 'string'
      ? deployment.network?.ports?.find((candidate) => candidate.name === probe.port)?.containerPort
      : (probe.port ?? deployment.network?.ports?.[0]?.containerPort);
  if (probe.type === 'exec') return ['CMD', ...probe.command];
  if (probe.type === 'tcp') return ['CMD', 'nc', '-z', '127.0.0.1', String(port)];
  return ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', `http://127.0.0.1:${port}${probe.path}`];
}

function coolifyLabels(deployment, targetDomain) {
  const domain =
    deployment.adapterOverrides?.coolify?.domain ?? deployment.network?.routes?.[0]?.host ?? targetDomain;
  return domain ? [`coolify.managed=true`, `coolify.domain=${domain}`] : ['coolify.managed=true'];
}

function requestFor(context, workloads) {
  const target = coolifyReferences(context.target);
  const serviceName = `${context.config?.project?.name ?? 'monox'}-${context.environment}`;
  const composeSource = `${JSON.stringify(compose(workloads, context.target, serviceName), null, 2)}\n`;
  return {
    method: 'POST',
    path: '/api/v1/services',
    auth: {
      type: 'bearer',
      tokenRef: target.tokenRef,
      requiredScopes: ['read', 'write', 'deploy'],
      forbiddenScopes: ['root'],
    },
    headers: { 'content-type': 'application/json' },
    body: {
      name: serviceName,
      project_uuid: target.projectRef,
      environment_name: target.environmentName ?? context.environment,
      server_uuid: target.serverRef,
      destination_uuid: target.destinationRef,
      docker_compose_raw: Buffer.from(composeSource).toString('base64'),
      instant_deploy: true,
    },
    composeSource,
  };
}

function confirmation(context) {
  return `${context.config?.project?.name ?? 'project'}/${context.environment}/${context.target.id}`;
}

export class CoolifyCloudapter {
  constructor() {
    this.id = 'coolify';
    this.version = '0.2.0-alpha.1';
    this.apiVersion = '1';
    this.capabilities = [
      'apply',
      'docker-compose',
      'health-gate',
      'render',
      'rollback',
      'services-api',
      'status',
    ];
  }

  async doctor(context) {
    const target = coolifyReferences(context?.target ?? {});
    const checks = [
      {
        id: 'server-ref',
        status: target.serverRef ? 'pass' : 'fail',
        message: 'target.serverRef is required',
      },
      { id: 'token-ref', status: target.tokenRef ? 'pass' : 'fail', message: 'coolify.tokenRef is required' },
      {
        id: 'request-transport',
        status: typeof context.coolify?.request === 'function' ? 'pass' : 'warning',
        message: 'apply requires an injected Coolify request transport',
      },
    ];
    return { ok: checks.every((check) => check.status !== 'fail'), checks };
  }

  async validate(context) {
    const errors = [];
    const target = coolifyReferences(context?.target ?? {});
    if (context?.target?.runtime !== 'coolify') errors.push('target.runtime must be coolify');
    for (const key of ['serverRef', 'projectRef', 'destinationRef', 'tokenRef']) {
      if (typeof target[key] !== 'string' || !target[key]) errors.push(`${key} is required`);
    }
    for (const workload of context?.workloads ?? []) {
      try {
        assertValidDeploymentSpecV2(workload.deployment);
      } catch (error) {
        errors.push(`${id(workload) ?? 'workload'}: ${error.message}`);
      }
    }
    try {
      compose(sorted(context?.workloads), context?.target ?? {}, 'validation');
    } catch (error) {
      errors.push(error.message);
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  async plan(context) {
    const validation = await this.validate(context);
    if (!validation.valid)
      throw new TypeError(`Coolify plan is invalid:\n- ${validation.errors.join('\n- ')}`);
    const workloads = sorted(context.workloads);
    const request = requestFor(context, workloads);
    const action = {
      operation: 'create-service',
      method: request.method,
      path: request.path,
      auth: request.auth,
      body: request.body,
      requestDigest: deterministicDigest({ method: request.method, path: request.path, body: request.body }),
    };
    return createPlan({
      adapter: this,
      project: context.config?.project,
      environment: context.environment,
      target: context.target,
      workloads,
      actions: [action],
      sourceDigest: context.sourceDigest,
      targetStateDigest: stateDigest(context),
      metadata: {
        endpoint: '/api/v1/services',
        tokenRef: request.auth.tokenRef,
        instantDeploy: true,
        healthGated: true,
      },
    });
  }

  async render(plan, context) {
    const request = requestFor(
      { ...context, target: plan.target, environment: plan.environment },
      plan.workloads
    );
    const safeRequest = {
      method: request.method,
      path: request.path,
      auth: request.auth,
      headers: request.headers,
      body: request.body,
    };
    const requestContent = `${JSON.stringify(safeRequest, null, 2)}\n`;
    return {
      planDigest: plan.digest,
      artifacts: [
        {
          name: 'docker-compose.json',
          mediaType: 'application/json',
          digest: deterministicDigest({ content: request.composeSource }),
          content: request.composeSource,
        },
        {
          name: 'coolify-service-request.json',
          mediaType: 'application/json',
          digest: deterministicDigest({ content: requestContent }),
          content: requestContent,
        },
      ],
      warnings: [],
    };
  }

  async apply(plan, context) {
    assertFreshPlan(plan, {
      adapter: this,
      sourceDigest: context.sourceDigest,
      targetStateDigest: stateDigest(context),
    });
    if (typeof context.coolify?.request !== 'function')
      throw new TypeError('Coolify apply requires context.coolify.request');
    const action = plan.actions[0];
    const result = await context.coolify.request({
      serverRef: context.target.serverRef,
      method: action.method,
      path: action.path,
      auth: action.auth,
      body: action.body,
    });
    if (result?.healthy !== true) {
      if (typeof context.coolify.rollback === 'function')
        await context.coolify.rollback({
          plan,
          revision: result?.previousRevision,
          reason: 'health-gate',
        });
      throw new Error('Coolify health gate failed');
    }
    return createReceipt({
      plan,
      result: { status: 'applied', changed: result?.changed !== false, response: result },
    });
  }

  async status(context) {
    if (typeof context.coolify?.status !== 'function')
      return { adapter: this.id, target: context.target?.id, status: 'unconfigured', changed: false };
    return context.coolify.status({ target: coolifyReferences(context.target) });
  }

  async rollback(request, context) {
    if (typeof context.coolify?.rollback !== 'function')
      throw new TypeError('Coolify rollback requires context.coolify.rollback');
    const plan = request.plan ?? (await this.plan(context));
    return createReceipt({
      plan,
      operation: 'rollback',
      result: await context.coolify.rollback({ revision: request.revision, plan }),
    });
  }

  async destroy(request, context) {
    const expected = confirmation(context);
    if (request.confirm !== expected) throw new TypeError(`Destroy confirmation must equal ${expected}`);
    if (typeof context.coolify?.destroy !== 'function')
      throw new TypeError('Coolify destroy requires context.coolify.destroy');
    const plan = request.plan ?? (await this.plan(context));
    return createReceipt({
      plan,
      operation: 'destroy',
      result: await context.coolify.destroy({ plan, ownedOnly: true }),
    });
  }
}

export function createCoolifyCloudapter() {
  return assertCloudapter(new CoolifyCloudapter());
}
