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

function stateDigest(context) {
  return (
    context.targetStateDigest ?? deterministicDigest({ target: context.target?.id, state: 'pm2-unknown' })
  );
}

function ordered(workloads = []) {
  return [...workloads].sort((left, right) => id(left).localeCompare(id(right)));
}

function releaseId(context) {
  return context.sourceDigest.replace(/^sha256:/, '').slice(0, 16);
}

function ecosystem(workloads, environment, releaseDirectory) {
  return {
    apps: workloads.map((workload) => {
      const deployment = workload.deployment;
      const command = deployment.runtime?.command ?? [];
      const override = deployment.adapterOverrides?.pm2 ?? {};
      return {
        name: deployment.id,
        cwd: deployment.runtime?.workingDirectory
          ? `${releaseDirectory}/${deployment.runtime.workingDirectory}`
          : releaseDirectory,
        script: command[0],
        args: command.slice(1),
        instances: override.instances ?? 1,
        exec_mode: override.execMode ?? 'fork',
        autorestart: deployment.kind !== 'job',
        env: { ...deployment.env?.values, MONOX_ENVIRONMENT: environment },
        requiredEnv: (deployment.env?.secretRefs ?? []).map(
          (reference) => reference.target ?? reference.name
        ),
        kill_timeout: (deployment.lifecycle?.terminationGracePeriodSeconds ?? 60) * 1000,
      };
    }),
  };
}

function confirmation(context) {
  return `${context.config?.project?.name ?? 'project'}/${context.environment}/${context.target.id}`;
}

export class Pm2Cloudapter {
  constructor() {
    this.id = 'pm2';
    this.version = '0.2.0-alpha.1';
    this.apiVersion = '1';
    this.capabilities = ['apply', 'health-gate', 'pm2', 'render', 'rollback', 'status'];
  }

  async doctor(context) {
    return {
      ok: context?.target?.runtime === 'pm2',
      checks: [
        {
          id: 'runtime',
          status: context?.target?.runtime === 'pm2' ? 'pass' : 'fail',
          message: 'target.runtime must be pm2',
        },
        {
          id: 'transport',
          status: typeof context.pm2?.execute === 'function' ? 'pass' : 'warning',
          message: 'apply requires an injected PM2 transport',
        },
      ],
    };
  }

  async validate(context) {
    const errors = [];
    if (context?.target?.runtime !== 'pm2') errors.push('target.runtime must be pm2');
    if (!context?.environment) errors.push('environment is required');
    if (!context?.sourceDigest) errors.push('sourceDigest is required');
    for (const workload of ordered(context?.workloads)) {
      const deployment = workload.deployment;
      try {
        assertValidDeploymentSpecV2(deployment);
      } catch (error) {
        errors.push(`${deployment?.id ?? 'workload'}: ${error.message}`);
        continue;
      }
      if (!deployment?.runtime?.command?.length)
        errors.push(`${deployment?.id ?? 'workload'} requires runtime.command`);
      if (['cron', 'static'].includes(deployment?.kind))
        errors.push(`${deployment.id} is not supported by PM2`);
      if (!deployment?.probes?.readiness && deployment?.kind !== 'job')
        errors.push(`${deployment.id} requires a readiness probe`);
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  async plan(context) {
    const validation = await this.validate(context);
    if (!validation.valid) throw new TypeError(`PM2 plan is invalid:\n- ${validation.errors.join('\n- ')}`);
    const workloads = ordered(context.workloads);
    const root = '/srv/monox';
    const releaseDirectory = `${root}/releases/${releaseId(context)}`;
    const actions = [
      { operation: 'stage-release', releaseDirectory },
      { operation: 'write-config', path: `${releaseDirectory}/ecosystem.config.json` },
      {
        operation: 'start-or-reload',
        executable: 'pm2',
        args: ['startOrReload', `${releaseDirectory}/ecosystem.config.json`, '--update-env'],
      },
      ...workloads
        .filter((workload) => workload.deployment.kind !== 'job')
        .map((workload) => ({
          operation: 'health-check',
          workload: id(workload),
          probe: workload.deployment.probes.readiness,
        })),
      { operation: 'promote-release', executable: 'ln', args: ['-sfn', releaseDirectory, `${root}/current`] },
      { operation: 'save-process-list', executable: 'pm2', args: ['save'] },
    ];
    return createPlan({
      adapter: this,
      project: context.config?.project,
      environment: context.environment,
      target: context.target,
      workloads,
      actions,
      sourceDigest: context.sourceDigest,
      targetStateDigest: stateDigest(context),
      metadata: { releaseDirectory, healthGated: true, automaticRollbackOnHealthFailure: true },
    });
  }

  async render(plan) {
    const config = ecosystem(plan.workloads, plan.environment, plan.metadata.releaseDirectory);
    const content = `${JSON.stringify(config, null, 2)}\n`;
    return {
      planDigest: plan.digest,
      artifacts: [
        {
          name: 'ecosystem.config.json',
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
    if (typeof context.pm2?.execute !== 'function')
      throw new TypeError('PM2 apply requires context.pm2.execute');
    const artifact = (await this.render(plan)).artifacts[0];
    const results = [];
    try {
      for (const action of plan.actions) {
        const result = await context.pm2.execute(action, { artifact });
        if (action.operation === 'health-check' && result?.healthy !== true)
          throw new Error(`Health gate failed for ${action.workload}`);
        results.push(result);
      }
    } catch (error) {
      if (typeof context.pm2.rollback === 'function')
        await context.pm2.rollback({ plan, reason: error.message });
      throw error;
    }
    return createReceipt({ plan, result: { status: 'applied', changed: true, actions: results } });
  }

  async status(context) {
    if (typeof context.pm2?.status !== 'function')
      return { adapter: this.id, target: context.target?.id, status: 'unconfigured', changed: false };
    return context.pm2.status({ workloads: ordered(context.workloads) });
  }

  async rollback(request, context) {
    if (typeof context.pm2?.rollback !== 'function')
      throw new TypeError('PM2 rollback requires context.pm2.rollback');
    const plan = request.plan ?? (await this.plan(context));
    return createReceipt({
      plan,
      operation: 'rollback',
      result: await context.pm2.rollback({ plan, revision: request.revision }),
    });
  }

  async destroy(request, context) {
    const expected = confirmation(context);
    if (request.confirm !== expected) throw new TypeError(`Destroy confirmation must equal ${expected}`);
    if (typeof context.pm2?.destroy !== 'function')
      throw new TypeError('PM2 destroy requires context.pm2.destroy');
    const plan = request.plan ?? (await this.plan(context));
    return createReceipt({
      plan,
      operation: 'destroy',
      result: await context.pm2.destroy({ plan, ownedOnly: true }),
    });
  }
}

export function createPm2Cloudapter() {
  return assertCloudapter(new Pm2Cloudapter());
}
