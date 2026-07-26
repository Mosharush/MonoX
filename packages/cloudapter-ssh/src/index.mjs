import {
  assertCloudapter,
  assertFreshPlan,
  createPlan,
  createReceipt,
  deterministicDigest,
} from '@monox/cloudapter-core';

const CREDENTIAL_MATERIAL = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b/i;

function connection(target) {
  return {
    serverRef: target.serverRef,
    identityRef: target.bindings?.identityRef,
    knownHostsRef: target.bindings?.secretStoreRef,
  };
}

function stateDigest(context) {
  return (
    context.targetStateDigest ?? deterministicDigest({ target: context.target?.id, state: 'ssh-unknown' })
  );
}

function validateRemoteAction(action, index, errors) {
  if (!action || typeof action !== 'object') {
    errors.push(`remoteActions[${index}] must be an object`);
    return;
  }
  if (typeof action.executable !== 'string' || !action.executable)
    errors.push(`remoteActions[${index}].executable is required`);
  if (!Array.isArray(action.args) || action.args.some((value) => typeof value !== 'string'))
    errors.push(`remoteActions[${index}].args must be a string array`);
  if ('command' in action || 'shell' in action)
    errors.push(`remoteActions[${index}] cannot contain a shell command`);
}

function confirmation(context) {
  return `${context.config?.project?.name ?? 'project'}/${context.environment}/${context.target.id}`;
}

export class SshCloudapter {
  constructor() {
    this.id = 'ssh';
    this.version = '0.2.0';
    this.apiVersion = '1';
    this.capabilities = ['apply', 'host-verification', 'render', 'rollback', 'ssh', 'status', 'upload'];
  }

  async doctor(context) {
    const ssh = connection(context.target ?? {});
    const checks = [
      {
        id: 'server-ref',
        status: ssh.serverRef ? 'pass' : 'fail',
        message: 'target.serverRef is required',
      },
      {
        id: 'identity-ref',
        status: ssh.identityRef ? 'pass' : 'fail',
        message: 'target.bindings.identityRef is required',
      },
      {
        id: 'known-hosts',
        status: ssh.knownHostsRef ? 'pass' : 'fail',
        message: 'target.bindings.secretStoreRef must reference pinned known-hosts data',
      },
      {
        id: 'executor',
        status: typeof context.ssh?.execute === 'function' ? 'pass' : 'warning',
        message: 'apply requires an injected SSH executor',
      },
    ];
    return { ok: checks.every((check) => check.status !== 'fail'), checks };
  }

  async validate(context) {
    const errors = [];
    const ssh = connection(context?.target ?? {});
    if (context?.target?.transport !== 'ssh') errors.push('target.transport must be ssh');
    for (const key of ['serverRef', 'identityRef', 'knownHostsRef']) {
      if (typeof ssh[key] !== 'string' || !ssh[key]) errors.push(`${key} is required`);
    }
    for (const [key, value] of Object.entries(ssh)) {
      if (typeof value === 'string' && CREDENTIAL_MATERIAL.test(value))
        errors.push(`${key} contains credential material`);
    }
    (context.remoteActions ?? []).forEach((action, index) => validateRemoteAction(action, index, errors));
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  async plan(context) {
    const validation = await this.validate(context);
    if (!validation.valid) throw new TypeError(`SSH plan is invalid:\n- ${validation.errors.join('\n- ')}`);
    const ssh = connection(context.target);
    const actions = [
      {
        operation: 'verify-host-key',
        knownHostsRef: ssh.knownHostsRef,
        serverRef: ssh.serverRef,
      },
      ...(context.artifacts ?? []).map((artifact) => ({
        operation: 'upload-artifact',
        artifactRef: artifact.digest ?? artifact.name,
        destination: artifact.destination,
      })),
      ...(context.remoteActions ?? []).map((action) => ({
        operation: 'remote-execute',
        executable: action.executable,
        args: action.args,
      })),
    ];
    return createPlan({
      adapter: this,
      project: context.config?.project,
      environment: context.environment,
      target: context.target,
      workloads: context.workloads,
      actions,
      sourceDigest: context.sourceDigest,
      targetStateDigest: stateDigest(context),
      metadata: { strictHostKeyChecking: true, identityRef: ssh.identityRef },
    });
  }

  async render(plan) {
    const content = `${JSON.stringify(
      {
        connection: {
          serverRef: plan.target.serverRef,
          identityRef: plan.target.bindings.identityRef,
          knownHostsRef: plan.target.bindings.secretStoreRef,
          strictHostKeyChecking: true,
        },
        actions: plan.actions,
      },
      null,
      2
    )}\n`;
    return {
      planDigest: plan.digest,
      artifacts: [
        {
          name: 'ssh-transport-plan.json',
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
    if (typeof context.ssh?.execute !== 'function')
      throw new TypeError('SSH apply requires context.ssh.execute');
    const results = [];
    for (const action of plan.actions)
      results.push(await context.ssh.execute(action, connection(context.target)));
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
    if (typeof context.ssh?.status !== 'function')
      return { adapter: this.id, target: context.target?.id, status: 'unconfigured', changed: false };
    return context.ssh.status(connection(context.target));
  }

  async rollback(request, context) {
    if (typeof context.ssh?.rollback !== 'function')
      throw new TypeError('SSH rollback requires context.ssh.rollback');
    const plan = request.plan ?? (await this.plan(context));
    return createReceipt({
      plan,
      operation: 'rollback',
      result: await context.ssh.rollback({ plan, revision: request.revision }),
    });
  }

  async destroy(request, context) {
    const expected = confirmation(context);
    if (request.confirm !== expected) throw new TypeError(`Destroy confirmation must equal ${expected}`);
    if (typeof context.ssh?.destroy !== 'function')
      throw new TypeError('SSH destroy requires context.ssh.destroy');
    const plan = request.plan ?? (await this.plan(context));
    return createReceipt({
      plan,
      operation: 'destroy',
      result: await context.ssh.destroy({ plan, ownedOnly: true }),
    });
  }
}

export function createSshCloudapter() {
  return assertCloudapter(new SshCloudapter());
}
