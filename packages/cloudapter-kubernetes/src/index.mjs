import {
  assertCloudapter,
  assertFreshPlan,
  createPlan,
  createReceipt,
  deterministicDigest,
} from '@monox/cloudapter-core';
import { buildKubernetesResources, renderKubernetesManifests } from '@monox/kube-renderer';

const VERSION = '0.2.0';

function workloadId(workload) {
  return workload.deployment?.id ?? workload.name ?? workload.id;
}

function ordered(workloads = []) {
  return [...workloads].sort((left, right) => workloadId(left).localeCompare(workloadId(right)));
}

function clone(value) {
  return structuredClone(value);
}

function sourceImageTag(context, workload) {
  return `source-${deterministicDigest({ sourceDigest: context.sourceDigest, workload: workloadId(workload) })
    .replace(/^sha256:/, '')
    .slice(0, 24)}`;
}

function materializeWorkload(workload, context) {
  const result = clone(workload);
  result.environment = context.environment;
  result.target = clone(context.target);
  const deployment = result.deployment;
  if (!deployment || typeof deployment !== 'object') return result;

  if (!deployment.build?.image) {
    const registry = context.target?.bindings?.registry?.replace(/\/+$/, '');
    if (!registry)
      throw new TypeError(
        `${workloadId(workload) ?? 'workload'} has no build.image and target.bindings.registry is missing`
      );
    deployment.build = {
      ...deployment.build,
      image: {
        repository: `${registry}/${deployment.id}`,
        tag: sourceImageTag(context, workload),
      },
    };
  }

  if (deployment.network?.exposure === 'public' && context.target?.bindings?.domain) {
    deployment.network.routes = (deployment.network.routes ?? []).map((route) => ({
      ...route,
      host: route.host ?? context.target.bindings.domain,
    }));
  }
  return result;
}

function materializedWorkloads(context) {
  return ordered(context?.workloads).map((workload) => materializeWorkload(workload, context));
}

function targetStateDigest(context) {
  return context.targetStateDigest ?? deterministicDigest({ target: context.target?.id, state: 'unknown' });
}

function confirmation(context) {
  const project = context.config?.project?.name ?? context.project?.name ?? 'project';
  return `${project}/${context.environment}/${context.target.id}`;
}

export class KubernetesCloudapter {
  constructor() {
    this.id = 'kubernetes';
    this.version = VERSION;
    this.apiVersion = '1';
    this.capabilities = [
      'apply',
      'destroy',
      'gpu',
      'hpa',
      'keda',
      'render',
      'rollback',
      'service-monitor',
      'status',
    ];
  }

  async doctor(context) {
    const checks = [
      {
        id: 'target-runtime',
        status: context.target?.runtime === 'kubernetes' ? 'pass' : 'fail',
        message: 'target.runtime must be kubernetes',
      },
      {
        id: 'target-transport',
        status: context.target?.transport === 'kubernetes-api' ? 'pass' : 'fail',
        message: 'target.transport must be kubernetes-api',
      },
      {
        id: 'cluster-ref',
        status: context.target?.clusterRef ? 'pass' : 'fail',
        message: 'target.clusterRef is required; implicit kube contexts are not allowed',
      },
      {
        id: 'cluster-transport',
        status: typeof context.kubernetes?.applyArtifact === 'function' ? 'pass' : 'warning',
        message: 'apply requires an injected applyArtifact transport',
      },
    ];
    return { ok: checks.every((check) => check.status !== 'fail'), checks };
  }

  async validate(context) {
    const errors = [];
    if (!context?.target?.id) errors.push('target.id is required');
    if (context?.target?.runtime !== 'kubernetes') errors.push('target.runtime must be kubernetes');
    if (context?.target?.transport !== 'kubernetes-api')
      errors.push('target.transport must be kubernetes-api');
    if (!context?.target?.clusterRef) errors.push('target.clusterRef is required');
    if (!context?.environment) errors.push('environment is required');
    if (!context?.sourceDigest) errors.push('sourceDigest is required');
    let workloads = [];
    try {
      workloads = materializedWorkloads(context);
    } catch (error) {
      errors.push(error.message);
    }
    for (const workload of workloads) {
      try {
        buildKubernetesResources(workload);
      } catch (error) {
        errors.push(`${workloadId(workload) ?? 'unknown'}: ${error.message}`);
      }
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  async plan(context) {
    const validation = await this.validate(context);
    if (!validation.valid)
      throw new TypeError(`Kubernetes plan is invalid:\n- ${validation.errors.join('\n- ')}`);
    const workloads = materializedWorkloads(context);
    const actions = workloads.map((workload) => {
      const resources = buildKubernetesResources(workload);
      return {
        operation: 'apply-manifests',
        workload: workloadId(workload),
        resourceIds: resources.map((resource) => `${resource.kind}/${resource.metadata.name}`),
        manifestDigest: deterministicDigest(resources),
      };
    });
    return createPlan({
      adapter: this,
      project: context.config?.project ?? context.project,
      environment: context.environment,
      target: context.target,
      workloads,
      actions,
      sourceDigest: context.sourceDigest,
      targetStateDigest: targetStateDigest(context),
      metadata: {
        renderer: '@monox/kube-renderer',
        applyTransportRequired: true,
        clusterRef: context.target.clusterRef,
        identityRef: context.target.bindings?.identityRef,
        namespace: context.target.bindings?.namespace,
      },
    });
  }

  async render(plan) {
    const artifacts = ordered(plan.workloads).map((workload) => {
      const content = renderKubernetesManifests(workload);
      return {
        name: `${workloadId(workload)}.kubernetes.yaml`,
        mediaType: 'application/yaml',
        digest: deterministicDigest({ content }),
        content,
      };
    });
    return { planDigest: plan.digest, artifacts, warnings: [] };
  }

  async apply(plan, context) {
    assertFreshPlan(plan, {
      adapter: this,
      sourceDigest: context.sourceDigest,
      targetStateDigest: targetStateDigest(context),
    });
    if (typeof context.kubernetes?.applyArtifact !== 'function')
      throw new TypeError('Kubernetes apply requires context.kubernetes.applyArtifact');
    const { artifacts } = await this.render(plan, context);
    const results = [];
    for (const artifact of artifacts)
      results.push(
        await context.kubernetes.applyArtifact(artifact, {
          clusterRef: context.target.clusterRef,
          identityRef: context.target.bindings?.identityRef,
          namespace: context.target.bindings?.namespace,
        })
      );
    return createReceipt({
      plan,
      result: {
        status: 'applied',
        changed: results.some((result) => result?.changed !== false),
        artifacts: results,
      },
    });
  }

  async status(context) {
    if (typeof context.kubernetes?.status !== 'function')
      return { adapter: this.id, target: context.target?.id, status: 'unconfigured', changed: false };
    return context.kubernetes.status({ target: context.target, workloads: ordered(context.workloads) });
  }

  async rollback(request, context) {
    if (typeof context.kubernetes?.rollback !== 'function')
      throw new TypeError('Kubernetes rollback requires context.kubernetes.rollback');
    const plan = request.plan ?? (await this.plan(context));
    const result = await context.kubernetes.rollback({ revision: request.revision, plan });
    return createReceipt({ plan, operation: 'rollback', result });
  }

  async destroy(request, context) {
    const expected = confirmation(context);
    if (request.confirm !== expected) throw new TypeError(`Destroy confirmation must equal ${expected}`);
    if (typeof context.kubernetes?.destroy !== 'function')
      throw new TypeError('Kubernetes destroy requires context.kubernetes.destroy');
    const plan = request.plan ?? (await this.plan(context));
    const result = await context.kubernetes.destroy({ plan, ownedOnly: true });
    return createReceipt({ plan, operation: 'destroy', result });
  }
}

export function createKubernetesCloudapter() {
  return assertCloudapter(new KubernetesCloudapter());
}
