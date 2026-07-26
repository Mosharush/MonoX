import {
  assertCloudapter,
  assertFreshPlan,
  createPlan,
  createReceipt,
  deterministicDigest,
} from '@monox/cloudapter-core';
import { assertValidDeploymentSpecV2 } from '@monox/deploy-schema';

function workloadId(workload) {
  return workload.deployment?.id ?? workload.id;
}

function ordered(workloads = []) {
  return [...workloads].sort((left, right) => workloadId(left).localeCompare(workloadId(right)));
}

function stateDigest(context) {
  return (
    context.targetStateDigest ?? deterministicDigest({ target: context.target?.id, state: 'static-unread' })
  );
}

function confirmation(context) {
  const project = context.config?.project?.name ?? context.project?.name ?? 'project';
  return `${project}/${context.environment}/${context.target.id}`;
}

function trimHyphens(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

function logicalReference(value) {
  const candidate = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-');
  return trimHyphens(candidate).slice(0, 63);
}

function actionFor(workload, context) {
  const deployment = assertValidDeploymentSpecV2(workload.deployment);
  if (deployment.kind !== 'static')
    throw new TypeError(`${deployment.id}: static targets accept only static workloads`);
  if (deployment.build.strategy !== 'static' || !deployment.build.output)
    throw new TypeError(`${deployment.id}: build.strategy must be static with build.output`);
  const provider = context.target.provider;
  if (!['aws', 'gcp'].includes(provider))
    throw new TypeError(`${deployment.id}: static delivery requires an aws or gcp target`);
  const project = context.config?.project?.name ?? context.project?.name ?? 'project';
  const base = logicalReference(`${project}-${context.environment}-${deployment.id}`);
  const overrides = deployment.adapterOverrides?.static ?? {};
  return {
    operation: 'publish-static-artifact',
    provider,
    workload: deployment.id,
    source: {
      workspace: workload.workspace?.location,
      output: deployment.build.output,
      artifactDigest: deterministicDigest({
        sourceDigest: context.sourceDigest,
        workspace: workload.workspace?.location,
        output: deployment.build.output,
      }),
    },
    destination: {
      originRef: overrides.bucket ?? `${base}-origin`,
      cdnRef: overrides.cdn ?? `${base}-cdn`,
      domain: context.target.bindings?.domain,
    },
    policy: {
      deleteUnmanaged: false,
      immutableAssets: true,
      invalidateEntryPoints: true,
    },
  };
}

export class StaticCloudapter {
  constructor() {
    this.id = 'static';
    this.version = '0.2.0';
    this.apiVersion = '1';
    this.capabilities = [
      'apply',
      'aws-s3-cloudfront',
      'destroy',
      'gcp-gcs-cdn',
      'render',
      'rollback',
      'status',
    ];
  }

  async doctor(context) {
    const checks = [
      {
        id: 'runtime',
        status: context.target?.runtime === 'static' ? 'pass' : 'fail',
        message: 'target.runtime must be static',
      },
      {
        id: 'provider',
        status: ['aws', 'gcp'].includes(context.target?.provider) ? 'pass' : 'fail',
        message: 'target.provider must be aws or gcp',
      },
      {
        id: 'executor',
        status: typeof context.static?.execute === 'function' ? 'pass' : 'warning',
        message: 'apply requires an injected static executor',
      },
    ];
    return { ok: checks.every((check) => check.status !== 'fail'), checks };
  }

  async validate(context) {
    const errors = [];
    if (!context?.environment) errors.push('environment is required');
    if (context?.target?.runtime !== 'static') errors.push('target.runtime must be static');
    if (!['aws', 'gcp'].includes(context?.target?.provider))
      errors.push('target.provider must be aws or gcp');
    for (const workload of ordered(context?.workloads)) {
      try {
        actionFor(workload, context);
      } catch (error) {
        errors.push(error.message);
      }
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  async plan(context) {
    const validation = await this.validate(context);
    if (!validation.valid)
      throw new TypeError(`Static plan is invalid:\n- ${validation.errors.join('\n- ')}`);
    const workloads = ordered(context.workloads);
    return createPlan({
      adapter: this,
      project: context.config?.project,
      environment: context.environment,
      target: context.target,
      workloads,
      actions: workloads.map((workload) => actionFor(workload, context)),
      sourceDigest: context.sourceDigest,
      targetStateDigest: stateDigest(context),
      metadata: { executionMode: 'injected-provider-sdk', unmanagedResourcesPreserved: true },
    });
  }

  async render(plan) {
    const content = `${JSON.stringify({ schemaVersion: '1', actions: plan.actions }, null, 2)}\n`;
    return {
      planDigest: plan.digest,
      artifacts: [
        {
          name: 'static-delivery-plan.json',
          mediaType: 'application/json',
          digest: deterministicDigest({ content }),
          content,
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
    if (typeof context.static?.execute !== 'function')
      throw new TypeError('Static apply requires context.static.execute');
    const results = [];
    for (const action of plan.actions) results.push(await context.static.execute(action));
    return createReceipt({
      plan,
      result: {
        status: 'applied',
        changed: results.some((result) => result?.changed !== false),
        actions: results,
      },
    });
  }

  async status(context) {
    if (typeof context.static?.status !== 'function')
      return { adapter: this.id, target: context.target?.id, status: 'unconfigured', changed: false };
    return context.static.status({ target: context.target, workloads: ordered(context.workloads) });
  }

  async rollback(request, context) {
    if (typeof context.static?.rollback !== 'function')
      throw new TypeError('Static rollback requires context.static.rollback');
    const plan = request.plan ?? (await this.plan(context));
    return createReceipt({
      plan,
      operation: 'rollback',
      result: await context.static.rollback({ plan, revision: request.revision }),
    });
  }

  async destroy(request, context) {
    const expected = confirmation(context);
    if (request.confirm !== expected) throw new TypeError(`Destroy confirmation must equal ${expected}`);
    if (typeof context.static?.destroy !== 'function')
      throw new TypeError('Static destroy requires context.static.destroy');
    const plan = request.plan ?? (await this.plan(context));
    return createReceipt({
      plan,
      operation: 'destroy',
      result: await context.static.destroy({ plan, ownedOnly: true, preserveData: true }),
    });
  }
}

export function createStaticCloudapter() {
  return assertCloudapter(new StaticCloudapter());
}
