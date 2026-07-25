import { assertCloudapter, assertFreshPlan, createPlan, deterministicDigest } from '@monox/cloudapter-core';

const CREDENTIAL_KEY = /(?:credential|private.?key|service.?account.?key|password|secret|token)/i;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;

function stateDigest(context) {
  return (
    context.targetStateDigest ?? deterministicDigest({ target: context.target?.id, state: 'gcp-unread' })
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
      provider: 'gcp',
      region: context.target.region,
      projectRef: context.target.projectRef,
      identityRef: context.target.bindings.identityRef,
      secretStoreRef: context.target.bindings.secretStoreRef,
    },
    { operation: 'ensure-registry', resource: 'artifact-registry', immutableReferences: true },
  ];
  switch (context.target.runtime) {
    case 'kubernetes':
      result.push(
        {
          operation: 'ensure-cluster',
          resource: 'gke-standard',
          privateNodes: true,
          dataplaneV2: true,
          workloadIdentity: true,
          shieldedNodes: true,
        },
        {
          operation: 'ensure-secret-integration',
          resource: 'secret-manager',
          secretStoreRef: context.target.bindings.secretStoreRef,
          rotationSeconds: 120,
          valuesInState: false,
        },
        {
          operation: 'ensure-observability',
          resource: 'google-cloud-monitoring',
          managedPrometheus: true,
          logging: ['SYSTEM_COMPONENTS', 'WORKLOADS'],
          metrics: [
            'SYSTEM_COMPONENTS',
            'STORAGE',
            'POD',
            'DEPLOYMENT',
            'STATEFULSET',
            'DAEMONSET',
            'HPA',
            'JOBSET',
            'CADVISOR',
            'KUBELET',
            'DCGM',
            'APISERVER',
            'SCHEDULER',
            'CONTROLLER_MANAGER',
          ],
          alerts: [{ metric: 'apiserver_request_duration_seconds', condition: 'p99 > 5s' }],
        }
      );
      if (hasGpu(context.workloads))
        result.push({
          operation: 'ensure-gpu-node-capacity',
          resource: 'gke-node-pool',
          capacity: ['spot', 'on-demand'],
          acceleratorResource: 'nvidia.com/gpu',
          dcgmMetrics: true,
        });
      break;
    case 'pm2':
    case 'docker':
      result.push(
        { operation: 'ensure-host', resource: 'compute-instance', externalIp: false, osLogin: true },
        { operation: 'ensure-transport', resource: 'iap-tunnel', sshKeyRequired: false }
      );
      break;
    case 'coolify':
      result.push(
        { operation: 'ensure-host', resource: 'compute-instance', externalIp: true, osLogin: true },
        { operation: 'bootstrap-coolify', tokenRefOnly: true, tlsRequired: true }
      );
      break;
    case 'static':
      result.push(
        { operation: 'ensure-static-origin', resource: 'cloud-storage', publicAccessPrevention: true },
        { operation: 'ensure-cdn', resource: 'cloud-cdn', managedCertificate: true }
      );
      break;
    default:
      throw new TypeError(`GCP runtime ${context.target.runtime} is not supported`);
  }
  return result;
}

function confirmation(context) {
  return `${context.config?.project?.name ?? 'project'}/${context.environment}/${context.target.id}`;
}

function unsupportedMutation(operation) {
  throw new TypeError(
    `GCP provider is plan-only in MonoX 0.2 alpha; ${operation} is unsupported and no infrastructure changes were made`
  );
}

export class GcpProviderCloudapter {
  constructor() {
    this.id = 'provider-gcp';
    this.version = '0.2.0-alpha.1';
    this.apiVersion = '1';
    this.capabilities = [
      'artifact-registry',
      'compute',
      'gcs-cdn',
      'gke',
      'gpu-capacity',
      'plan',
      'pulumi-automation',
      'workload-identity-federation',
    ];
  }

  async doctor(context) {
    const target = context?.target ?? {};
    const checks = [
      {
        id: 'provider',
        status: context?.target?.provider === 'gcp' ? 'pass' : 'fail',
        message: 'target.provider must be gcp',
      },
      {
        id: 'region',
        status: target.region ? 'pass' : 'fail',
        message: 'target.region is required',
      },
      {
        id: 'wif-provider',
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
      { id: 'execution', status: 'warning', message: '0.2 alpha provider is plan-only' },
    ];
    return { ok: checks.every((check) => check.status !== 'fail'), checks };
  }

  async validate(context) {
    const errors = [];
    const target = context?.target ?? {};
    if (context?.target?.provider !== 'gcp') errors.push('target.provider must be gcp');
    if (context?.target?.provisioner !== 'pulumi') errors.push('target.provisioner must be pulumi');
    if (!target.region) errors.push('target.region is required');
    if (!target.projectRef) errors.push('target.projectRef is required');
    if (!target.bindings?.identityRef) errors.push('target.bindings.identityRef is required');
    if (!target.bindings?.secretStoreRef) errors.push('target.bindings.secretStoreRef is required');
    for (const [key, value] of Object.entries(target.bindings ?? {})) {
      if (CREDENTIAL_KEY.test(key) && !/(?:ref|reference)$/i.test(key))
        errors.push(`target.bindings.${key} is not allowed; use an identity reference`);
      if (typeof value === 'string' && PRIVATE_KEY.test(value))
        errors.push(`target.bindings.${key} contains private key material`);
    }
    try {
      actions(context);
    } catch (error) {
      errors.push(error.message);
    }
    return { valid: errors.length === 0, errors, warnings: ['GCP provider alpha is plan-only'] };
  }

  async plan(context) {
    const validation = await this.validate(context);
    if (!validation.valid)
      throw new TypeError(`GCP provider plan is invalid:\n- ${validation.errors.join('\n- ')}`);
    return createPlan({
      adapter: this,
      project: context.config?.project,
      environment: context.environment,
      target: context.target,
      workloads: context.workloads,
      actions: actions(context),
      sourceDigest: context.sourceDigest,
      targetStateDigest: stateDigest(context),
      metadata: {
        engine: 'pulumi-automation-api',
        execution: 'plan-only',
        identity: 'workload-identity-federation',
      },
    });
  }

  async render(plan) {
    const content = `${JSON.stringify({ schemaVersion: '1', kind: 'PulumiStackIntent', provider: 'gcp', target: plan.target, actions: plan.actions }, null, 2)}\n`;
    return {
      planDigest: plan.digest,
      artifacts: [
        {
          name: 'gcp.pulumi-intent.json',
          mediaType: 'application/json',
          digest: deterministicDigest({ content }),
          content,
        },
      ],
      warnings: ['Plan only: no Google Cloud calls were made'],
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

export function createGcpProviderCloudapter() {
  return assertCloudapter(new GcpProviderCloudapter());
}
