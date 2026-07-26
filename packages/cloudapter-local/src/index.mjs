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

function sorted(workloads = []) {
  return [...workloads].sort((left, right) => workloadId(left).localeCompare(workloadId(right)));
}

const localComposeFile = 'infra/local/docker-compose.yml';
const addonComposeFile = 'infra/docker/addons.compose.yaml';
const composeServicePattern = /^[a-z][a-z0-9_.-]{0,127}$/;

function bundledAddons(context) {
  return Object.values(context.config?.addons ?? {})
    .filter(
      (addon) =>
        addon.enabled === true &&
        addon.mode === 'bundled' &&
        (!addon.environments || addon.environments.includes(context.environment))
    )
    .sort((left, right) => left.recipe.localeCompare(right.recipe));
}

function composeFiles(context) {
  return [localComposeFile, ...(bundledAddons(context).length ? [addonComposeFile] : [])];
}

function ownedComposeServices(context) {
  return [
    ...new Set([
      ...sorted(context.workloads).map(workloadId),
      ...bundledAddons(context).map((addon) => addon.recipe),
    ]),
  ].sort();
}

function trimComposeEdges(value) {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === '-' || value[start] === '_')) start += 1;
  while (end > start && (value[end - 1] === '-' || value[end - 1] === '_')) end -= 1;
  return value.slice(start, end);
}

function composeProjectName(context) {
  const candidate = `${context.config?.project?.name ?? 'project'}-${context.environment ?? 'local'}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/g, '-')
    .replaceAll(/-+/g, '-');
  const value = trimComposeEdges(candidate).slice(0, 63);
  return value || 'monox-local';
}

function stateDigest(context) {
  return (
    context.targetStateDigest ?? deterministicDigest({ target: context.target?.id, state: 'local-unknown' })
  );
}

function expectedConfirmation(context) {
  return `${context.config?.project?.name ?? 'project'}/${context.environment}/${context.target.id}`;
}

export class LocalCloudapter {
  constructor() {
    this.id = 'local';
    this.version = '0.2.0';
    this.apiVersion = '1';
    this.capabilities = ['apply', 'destroy', 'docker-compose', 'health-gate', 'render', 'rollback', 'status'];
  }

  async doctor(context) {
    const targetIsLocalDocker =
      context?.target?.transport === 'local' && context?.target?.runtime === 'docker';
    const executorCheck =
      typeof context.local?.doctor === 'function'
        ? await context.local.doctor({
            composeFiles: composeFiles(context),
            projectName: composeProjectName(context),
          })
        : { ok: typeof context.local?.execute === 'function' };
    return {
      ok: Boolean(context?.target?.id) && targetIsLocalDocker && executorCheck.ok,
      checks: [
        {
          id: 'target',
          status: context?.target?.id ? 'pass' : 'fail',
          message: 'a local target is required',
        },
        {
          id: 'transport-runtime',
          status: targetIsLocalDocker ? 'pass' : 'fail',
          message: 'target.transport must be local and target.runtime must be docker',
        },
        {
          id: 'executor',
          status: executorCheck.ok ? 'pass' : 'fail',
          message: executorCheck.ok
            ? `Docker Compose is available for ${(executorCheck.composeFiles ?? composeFiles(context)).join(', ')}`
            : (executorCheck.message ?? 'Docker Compose execution is unavailable'),
        },
      ],
    };
  }

  async validate(context) {
    const errors = [];
    if (!context?.environment) errors.push('environment is required');
    if (!context?.target?.id) errors.push('target.id is required');
    if (context?.target?.transport !== 'local') errors.push('target.transport must be local');
    if (context?.target?.runtime !== 'docker') errors.push('target.runtime must be docker');
    if (!context?.sourceDigest) errors.push('sourceDigest is required');
    for (const addon of bundledAddons(context)) {
      if (!composeServicePattern.test(addon.recipe))
        errors.push(`bundled local add-on recipe ${addon.recipe} is not a supported Compose service id`);
    }
    for (const workload of context?.workloads ?? []) {
      try {
        assertValidDeploymentSpecV2(workload.deployment);
      } catch (error) {
        errors.push(`${workloadId(workload) ?? 'workload'}: ${error.message}`);
      }
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  async plan(context) {
    const validation = await this.validate(context);
    if (!validation.valid) throw new TypeError(`Local plan is invalid:\n- ${validation.errors.join('\n- ')}`);
    const workloads = sorted(context.workloads);
    const files = composeFiles(context);
    const projectName = composeProjectName(context);
    const prefix = files.flatMap((composeFile) => ['-f', composeFile]);
    const ownedServices = ownedComposeServices(context);
    const actions = [
      {
        operation: 'validate-compose',
        executable: 'docker',
        args: ['compose', '--project-name', projectName, ...prefix, 'config', '--services'],
      },
      {
        operation: 'start-compose',
        executable: 'docker',
        args: ['compose', '--project-name', projectName, ...prefix, 'up', '--detach', ...ownedServices],
      },
      ...workloads
        .filter((workload) => workload.deployment?.probes?.readiness ?? workload.deployment?.probes?.liveness)
        .map((workload) => ({
          operation: 'health-check',
          workload: workloadId(workload),
          probe: workload.deployment?.probes?.readiness ?? workload.deployment?.probes?.liveness,
        })),
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
      metadata: {
        composeFiles: files,
        composeProjectName: projectName,
        executionMode: 'argument-arrays',
        healthGated: true,
        ownedComposeServices: ownedServices,
        ownedOnly: true,
      },
    });
  }

  async render(plan) {
    const content = `${JSON.stringify({ schemaVersion: '1', actions: plan.actions }, null, 2)}\n`;
    return {
      planDigest: plan.digest,
      artifacts: [
        {
          name: 'local-delivery-plan.json',
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
    if (typeof context.local?.execute !== 'function')
      throw new TypeError('Local apply requires context.local.execute');
    const results = [];
    let started = false;
    try {
      for (const action of plan.actions) {
        const result = await context.local.execute(action, { plan });
        if (action.operation === 'start-compose') started = true;
        if (action.operation === 'health-check' && result?.healthy !== true)
          throw new Error(`Health gate failed for ${action.workload}`);
        results.push(result);
      }
    } catch (error) {
      if (started && typeof context.local.rollback === 'function')
        await context.local.rollback({ plan, ownedOnly: true, reason: error.message });
      throw error;
    }
    return createReceipt({ plan, result: { status: 'applied', changed: true, actions: results } });
  }

  async status(context) {
    if (typeof context.local?.status !== 'function')
      return { adapter: this.id, target: context.target?.id, status: 'unconfigured', changed: false };
    return context.local.status({
      workloads: sorted(context.workloads),
      target: context.target,
      composeFiles: composeFiles(context),
      projectName: composeProjectName(context),
      ownedServices: ownedComposeServices(context),
    });
  }

  async rollback(request, context) {
    if (typeof context.local?.rollback !== 'function')
      throw new TypeError('Local rollback requires context.local.rollback');
    const plan = request.plan ?? (await this.plan(context));
    return createReceipt({
      plan,
      operation: 'rollback',
      result: await context.local.rollback({ ...request, plan, ownedOnly: true }),
    });
  }

  async destroy(request, context) {
    const expected = expectedConfirmation(context);
    if (request.confirm !== expected) throw new TypeError(`Destroy confirmation must equal ${expected}`);
    if (typeof context.local?.destroy !== 'function')
      throw new TypeError('Local destroy requires context.local.destroy');
    const plan = request.plan ?? (await this.plan(context));
    return createReceipt({
      plan,
      operation: 'destroy',
      result: await context.local.destroy({ ...request, plan, ownedOnly: true }),
    });
  }
}

export function createLocalCloudapter() {
  return assertCloudapter(new LocalCloudapter());
}
