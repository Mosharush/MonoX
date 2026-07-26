import { assertCloudapter, assertFreshPlan, createPlan, deterministicDigest } from '@monox/cloudapter-core';

const CREDENTIAL_KEY = /(?:access.?key|secret|password|private.?key|token)/i;

function stateDigest(context) {
  return (
    context.targetStateDigest ?? deterministicDigest({ target: context.target?.id, state: 'aws-unread' })
  );
}

function hasGpu(workloads = []) {
  return workloads.some((workload) =>
    (workload.deployment?.resources?.accelerators ?? []).some((accelerator) => accelerator.count > 0)
  );
}

function actions(context) {
  const result = [
    {
      operation: 'configure-provider',
      provider: 'aws',
      region: context.target.region,
      projectRef: context.target.projectRef,
      identityRef: context.target.bindings.identityRef,
      secretStoreRef: context.target.bindings.secretStoreRef,
    },
    { operation: 'ensure-registry', resource: 'ecr', immutableTags: true, scanOnPush: true },
  ];
  switch (context.target.runtime) {
    case 'kubernetes':
      result.push(
        {
          operation: 'ensure-cluster',
          resource: 'eks',
          privateEndpoint: true,
          oidcProvider: true,
          encryptedSecrets: true,
        },
        { operation: 'ensure-workload-identity', resource: 'irsa', roleRefsOnly: true },
        {
          operation: 'ensure-secret-integration',
          resource: 'external-secrets',
          backend: 'secrets-manager',
          secretStoreRef: context.target.bindings.secretStoreRef,
        },
        { operation: 'ensure-observability', resource: 'managed-prometheus', controlPlaneAlerts: true }
      );
      if (hasGpu(context.workloads))
        result.push({
          operation: 'ensure-gpu-node-capacity',
          resource: 'eks-managed-node-group',
          capacity: ['spot', 'on-demand'],
          acceleratorResource: 'nvidia.com/gpu',
        });
      break;
    case 'pm2':
    case 'docker':
      result.push(
        { operation: 'ensure-host', resource: 'ec2', privateAccess: true },
        { operation: 'ensure-transport', resource: 'ssm', sshPortRequired: false }
      );
      break;
    case 'coolify':
      result.push(
        { operation: 'ensure-host', resource: 'ec2', privateAccess: false },
        { operation: 'bootstrap-coolify', tokenRefOnly: true, tlsRequired: true }
      );
      break;
    case 'static':
      result.push(
        { operation: 'ensure-static-origin', resource: 's3', publicAccessBlocked: true },
        { operation: 'ensure-cdn', resource: 'cloudfront', originAccessControl: true }
      );
      break;
    default:
      throw new TypeError(`AWS runtime ${context.target.runtime} is not supported`);
  }
  return result;
}

function confirmation(context) {
  return `${context.config?.project?.name ?? 'project'}/${context.environment}/${context.target.id}`;
}

function unsupportedMutation(operation) {
  throw new TypeError(
    `AWS provider is plan-only in MonoX 0.2.0; ${operation} is unsupported and no infrastructure changes were made`
  );
}

export class AwsProviderCloudapter {
  constructor() {
    this.id = 'provider-aws';
    this.version = '0.2.0';
    this.apiVersion = '1';
    this.capabilities = [
      'ec2',
      'ecr',
      'eks',
      'gpu-capacity',
      'oidc',
      'plan',
      'pulumi-automation',
      's3-cloudfront',
    ];
  }

  async doctor(context) {
    const target = context?.target ?? {};
    const checks = [
      {
        id: 'provider',
        status: context?.target?.provider === 'aws' ? 'pass' : 'fail',
        message: 'target.provider must be aws',
      },
      {
        id: 'region',
        status: target.region ? 'pass' : 'fail',
        message: 'target.region is required',
      },
      {
        id: 'oidc',
        status: target.bindings?.identityRef ? 'pass' : 'fail',
        message: 'target.bindings.identityRef is required',
      },
      {
        id: 'project-ref',
        status: target.projectRef ? 'pass' : 'fail',
        message: 'target.projectRef is required',
      },
      {
        id: 'secret-store-ref',
        status: target.bindings?.secretStoreRef ? 'pass' : 'fail',
        message: 'target.bindings.secretStoreRef is required',
      },
      { id: 'execution', status: 'warning', message: '0.2.0 provider is plan-only' },
    ];
    return { ok: checks.every((check) => check.status !== 'fail'), checks };
  }

  async validate(context) {
    const errors = [];
    const target = context?.target ?? {};
    if (context?.target?.provider !== 'aws') errors.push('target.provider must be aws');
    if (context?.target?.provisioner !== 'pulumi') errors.push('target.provisioner must be pulumi');
    if (!target.region) errors.push('target.region is required');
    if (!target.projectRef) errors.push('target.projectRef is required');
    if (!target.bindings?.identityRef) errors.push('target.bindings.identityRef is required');
    if (!target.bindings?.secretStoreRef) errors.push('target.bindings.secretStoreRef is required');
    for (const key of Object.keys(target.bindings ?? {})) {
      if (CREDENTIAL_KEY.test(key) && !/(?:ref|reference)$/i.test(key))
        errors.push(`target.bindings.${key} is not allowed; use an identity reference`);
    }
    try {
      actions(context);
    } catch (error) {
      errors.push(error.message);
    }
    return { valid: errors.length === 0, errors, warnings: ['AWS provider 0.2.0 is plan-only'] };
  }

  async plan(context) {
    const validation = await this.validate(context);
    if (!validation.valid)
      throw new TypeError(`AWS provider plan is invalid:\n- ${validation.errors.join('\n- ')}`);
    return createPlan({
      adapter: this,
      project: context.config?.project,
      environment: context.environment,
      target: context.target,
      workloads: context.workloads,
      actions: actions(context),
      sourceDigest: context.sourceDigest,
      targetStateDigest: stateDigest(context),
      metadata: { engine: 'pulumi-automation-api', execution: 'plan-only', identity: 'github-oidc' },
    });
  }

  async render(plan) {
    const content = `${JSON.stringify({ schemaVersion: '1', kind: 'PulumiStackIntent', provider: 'aws', target: plan.target, actions: plan.actions }, null, 2)}\n`;
    return {
      planDigest: plan.digest,
      artifacts: [
        {
          name: 'aws.pulumi-intent.json',
          mediaType: 'application/json',
          digest: deterministicDigest({ content }),
          content,
        },
      ],
      warnings: ['Plan only: no AWS calls were made'],
    };
  }

  async apply(plan, context) {
    assertFreshPlan(plan, {
      adapter: this,
      sourceDigest: context.sourceDigest,
      targetStateDigest: stateDigest(context),
    });
    unsupportedMutation('apply');
  }

  async status(context) {
    return { adapter: this.id, target: context.target?.id, status: 'plan-only', changed: false };
  }

  async rollback() {
    unsupportedMutation('rollback');
  }

  async destroy(request, context) {
    const expected = confirmation(context);
    if (request.confirm !== expected) throw new TypeError(`Destroy confirmation must equal ${expected}`);
    unsupportedMutation('destroy');
  }
}

export function createAwsProviderCloudapter() {
  return assertCloudapter(new AwsProviderCloudapter());
}
