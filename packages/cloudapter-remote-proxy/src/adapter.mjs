import {
  assertCloudapter,
  assertFreshPlan,
  createPlan,
  createReceipt,
  deterministicDigest,
} from '@monox/cloudapter-core';

import {
  REMOTE_PROXY_POLICY,
  disabledRemoteProxyConfig,
  isProductionContext,
  remoteProxyCredentialFindings,
  validateRemoteProxyConfig,
} from './policy.mjs';
import { startRemoteProxyServer } from './server.mjs';

function stateDigest(context) {
  return (
    context.targetStateDigest ??
    deterministicDigest({ target: context.target?.id, state: 'remote-proxy-unconfigured' })
  );
}

function confirmation(context) {
  return `${context.config?.project?.name ?? 'project'}/${context.environment}/${context.target.id}`;
}

function selectedConfig(context) {
  return context.remoteProxy ?? disabledRemoteProxyConfig();
}

function planMetadata(config, context) {
  const enabled = config.enabled === true && !isProductionContext(context);
  return {
    enabled,
    listen: config.listen,
    allowlist: enabled ? config.allowlist : [],
    bind: REMOTE_PROXY_POLICY.bind,
    dns: REMOTE_PROXY_POLICY.dns,
    headerPolicy: 'strip-sensitive',
    privateRanges: REMOTE_PROXY_POLICY.privateRanges,
    production: 'forbidden',
    redirects: REMOTE_PROXY_POLICY.redirects,
  };
}

export class RemoteProxyCloudapter {
  constructor() {
    this.id = 'remote-proxy';
    this.version = '0.2.0';
    this.apiVersion = '1';
    this.capabilities = ['allowlist', 'local-only', 'render'];
    this.listeners = new Map();
  }

  async doctor(context) {
    const config = selectedConfig(context ?? {});
    const validation = validateRemoteProxyConfig(config);
    const production = isProductionContext(context ?? {});
    const local = !context?.target?.transport || context.target.transport === 'local';
    const checks = [
      {
        id: 'enabled',
        status: config.enabled === true ? 'warning' : 'pass',
        message:
          config.enabled === true
            ? 'remote proxy is explicitly enabled for local development'
            : 'remote proxy is disabled',
      },
      {
        id: 'production',
        status: production && config.enabled === true ? 'fail' : 'pass',
        message: 'remote proxy cannot run in production',
      },
      {
        id: 'config',
        status: validation.valid ? 'pass' : 'fail',
        message: validation.valid ? 'allowlist config is valid' : validation.errors.join('; '),
      },
      {
        id: 'transport',
        status: !config.enabled || local ? 'pass' : 'fail',
        message: 'an enabled remote proxy requires a local transport',
      },
    ];
    return { ok: checks.every((check) => check.status !== 'fail'), checks };
  }

  async validate(context) {
    const errors = [];
    if (!context?.environment) errors.push('environment is required');
    if (!context?.target?.id) errors.push('target.id is required');
    if (!context?.sourceDigest) errors.push('sourceDigest is required');
    const config = selectedConfig(context ?? {});
    const validation = validateRemoteProxyConfig(config);
    errors.push(...validation.errors);
    if (validation.valid && validation.value.enabled && isProductionContext(context))
      errors.push('remote proxy cannot be enabled for production');
    if (validation.valid && validation.value.enabled && context?.target?.transport !== 'local')
      errors.push('remote proxy can be enabled only for a local transport');
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  async plan(context) {
    const validation = await this.validate(context);
    if (!validation.valid)
      throw new TypeError(`Remote proxy plan is invalid:\n- ${validation.errors.join('\n- ')}`);
    const config = validateRemoteProxyConfig(selectedConfig(context)).value;
    const metadata = planMetadata(config, context);
    return createPlan({
      adapter: this,
      project: context.config?.project,
      environment: context.environment,
      target: context.target,
      workloads: context.workloads ?? [],
      actions: [
        metadata.enabled
          ? { operation: 'serve-local-proxy', listen: metadata.listen, allowlist: metadata.allowlist }
          : { operation: 'disabled' },
      ],
      sourceDigest: context.sourceDigest,
      targetStateDigest: stateDigest(context),
      metadata,
    });
  }

  async render(plan, context = {}) {
    const production = isProductionContext({
      ...context,
      environment: context.environment ?? plan.environment,
    });
    const enabled = plan.metadata.enabled === true && !production;
    const document = {
      schemaVersion: '1',
      enabled,
      listen: plan.metadata.listen,
      allowlist: enabled ? plan.metadata.allowlist : [],
      credentialForwarding: 'never',
      policy: REMOTE_PROXY_POLICY,
    };
    const findings = remoteProxyCredentialFindings(document);
    if (findings.length)
      throw new TypeError(`Refusing to render credential material: ${findings.join('; ')}`);
    const content = `${JSON.stringify(document, null, 2)}\n`;
    return {
      planDigest: plan.digest,
      artifacts: [
        {
          name: 'remote-proxy.plan.json',
          mediaType: 'application/json',
          digest: deterministicDigest({ content }),
          content,
        },
      ],
      warnings: production ? ['remote proxy is disabled in production artifacts'] : [],
    };
  }

  async apply(plan, context) {
    assertFreshPlan(plan, {
      adapter: this,
      sourceDigest: context.sourceDigest,
      targetStateDigest: stateDigest(context),
    });
    if (plan.metadata.enabled !== true || isProductionContext(context)) {
      if (isProductionContext(context) && plan.metadata.enabled === true)
        throw new TypeError('Remote proxy cannot be enabled for production');
      return createReceipt({ plan, result: { status: 'disabled', changed: false } });
    }
    const handle = await startRemoteProxyServer({
      config: context.remoteProxy,
      lookup: context.lookup,
      transport: context.transport,
      context,
    });
    this.listeners.set(plan.digest, handle);
    return createReceipt({
      plan,
      result: { status: 'listening', changed: true, listen: handle.address },
    });
  }

  async status(context) {
    const config = selectedConfig(context ?? {});
    return {
      adapter: this.id,
      environment: context?.environment,
      target: context?.target?.id,
      status: config.enabled === true ? 'configured' : 'disabled',
      changed: false,
      listeners: this.listeners.size,
    };
  }

  async rollback(request, context) {
    const plan = request.plan ?? (await this.plan(context));
    const handle = this.listeners.get(plan.digest);
    if (handle) {
      await handle.close();
      this.listeners.delete(plan.digest);
    }
    return createReceipt({
      plan,
      operation: 'rollback',
      result: { status: handle ? 'stopped' : 'disabled', changed: Boolean(handle) },
    });
  }

  async destroy(request, context) {
    const expected = confirmation(context);
    if (request.confirm !== expected) throw new TypeError(`Destroy confirmation must equal ${expected}`);
    const plan = request.plan ?? (await this.plan(context));
    const handle = this.listeners.get(plan.digest);
    if (handle) {
      await handle.close();
      this.listeners.delete(plan.digest);
    }
    return createReceipt({
      plan,
      operation: 'destroy',
      result: { status: handle ? 'stopped' : 'disabled', changed: Boolean(handle) },
    });
  }
}

export function createRemoteProxyCloudapter() {
  return assertCloudapter(new RemoteProxyCloudapter());
}
