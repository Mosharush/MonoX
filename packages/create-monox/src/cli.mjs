#!/usr/bin/env node

import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ADDON_IDS,
  AVAILABLE_DELIVERY_IDS,
  PLANNED_DELIVERY_IDS,
  WORKSPACE_TEMPLATE_IDS,
  assertAddon,
  assertDelivery,
} from './catalog.mjs';
import {
  ENVIRONMENTS,
  GENERATOR_VERSION,
  INFRA_OPTIONS,
  PACKAGE_MANAGERS,
  generateProject,
  packageManagerShellCommand,
  parseWorkspaceSelection,
  resolveDestination,
} from './generator.mjs';

const CONFIG_KEYS = new Set([
  'name',
  'directory',
  'packageManager',
  'infra',
  'workspaces',
  'addons',
  'delivery',
  'environment',
  'git',
  'install',
]);

export function parseArguments(argv) {
  const result = {
    name: undefined,
    directory: undefined,
    packageManager: undefined,
    infra: undefined,
    workspaces: [],
    addons: [],
    delivery: undefined,
    environment: undefined,
    config: undefined,
    interactive: false,
    dryRun: false,
    yes: false,
    git: undefined,
    install: undefined,
    help: false,
    version: false,
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--version' || argument === '-v') result.version = true;
    else if (argument === '--yes') result.yes = true;
    else if (argument === '--interactive') result.interactive = true;
    else if (argument === '--dry-run') result.dryRun = true;
    else if (argument === '--no-git') result.git = false;
    else if (argument === '--git') result.git = true;
    else if (argument === '--install') result.install = true;
    else if (argument === '--no-install') result.install = false;
    else {
      const option = readKnownOption(argv, index, argument);
      if (option) {
        index = option.index;
        if (option.name === 'workspace') result.workspaces.push(option.value);
        else if (option.name === 'addon') result.addons.push(option.value);
        else result[option.name] = option.value;
      } else if (argument.startsWith('-')) {
        throw new Error(`Unknown option: ${argument}`);
      } else {
        positionals.push(argument);
      }
    }
  }

  if (positionals.length > 1) throw new Error('Expected one project name.');
  result.name = positionals[0];
  if (!result.help && !result.version && !result.name && !result.config && !result.interactive) {
    throw new Error('A project name, --config, or --interactive is required.');
  }
  validateParsedOptions(result);
  return result;
}

function readKnownOption(argv, index, argument) {
  for (const [flag, name] of [
    ['--directory', 'directory'],
    ['--package-manager', 'packageManager'],
    ['--infra', 'infra'],
    ['--workspace', 'workspace'],
    ['--addon', 'addon'],
    ['--delivery', 'delivery'],
    ['--environment', 'environment'],
    ['--config', 'config'],
  ]) {
    const value = readOptionValue(argv, index, argument, flag);
    if (value) return { ...value, name };
  }
  return undefined;
}

function validateParsedOptions(options) {
  if (options.packageManager && !PACKAGE_MANAGERS.includes(options.packageManager)) {
    throw new Error(`Package manager must be one of: ${PACKAGE_MANAGERS.join(', ')}.`);
  }
  if (options.infra && !INFRA_OPTIONS.includes(options.infra)) {
    throw new Error(`Infrastructure must be one of: ${INFRA_OPTIONS.join(', ')}.`);
  }
  if (options.environment && !ENVIRONMENTS.includes(options.environment)) {
    throw new Error(`Environment must be one of: ${ENVIRONMENTS.join(', ')}.`);
  }
  options.workspaces.forEach(parseWorkspaceSelection);
  options.addons.forEach(assertAddon);
  if (options.delivery) assertDelivery(options.delivery);
}

export async function loadConfiguration(path, cwd = process.cwd()) {
  if (typeof path !== 'string' || path.trim() === '') throw new Error('--config requires a nonempty path.');
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const contents = await readFile(absolutePath, 'utf8');
  if (Buffer.byteLength(contents, 'utf8') > 1024 * 1024)
    throw new Error('Configuration file must be smaller than 1 MiB.');
  let value;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Cannot parse configuration JSON: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Configuration must be a JSON object.');
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`Unsupported configuration property: ${key}.`);
  }
  if (value.directory && !isAbsolute(value.directory))
    value.directory = resolve(dirname(absolutePath), value.directory);
  return value;
}

export async function main(
  argv = process.argv.slice(2),
  io = { input: process.stdin, output: process.stdout, error: process.stderr }
) {
  try {
    const parsed = parseArguments(argv);
    if (parsed.help) {
      io.output.write(helpText());
      return 0;
    }
    if (parsed.version) {
      io.output.write(`${GENERATOR_VERSION}\n`);
      return 0;
    }

    const configured = parsed.config ? await loadConfiguration(parsed.config) : {};
    let options = mergeOptions(configured, parsed);
    if (parsed.interactive) options = await collectInteractiveOptions(options, io);
    if (!options.name) throw new Error('A project name is required.');
    const directory = resolveDestination(options);

    if (!parsed.dryRun) {
      const approved =
        parsed.yes || parsed.interactive || (await confirmGeneration(options.name, directory, io));
      if (!approved) {
        io.output.write('Cancelled.\n');
        return 0;
      }
    }

    const result = await generateProject({ ...options, directory, dryRun: parsed.dryRun });
    if (result.dryRun) {
      io.output.write(
        `Dry run for ${result.name}: ${result.files.length} files would be written to ${result.directory}\n`
      );
      for (const path of result.files) io.output.write(`  ${path}\n`);
      return 0;
    }

    io.output.write(`Created ${result.name} in ${result.directory}\n`);
    io.output.write(`Package manager: ${result.packageManager}\n`);
    io.output.write(
      `Workspaces: ${result.workspaces.map(({ name, template }) => `${name}=${template}`).join(', ')}\n`
    );
    io.output.write(`Delivery: ${result.delivery}\n`);
    if (!result.installed) {
      io.output.write(
        `Next: cd ${quotePath(result.directory)} && ${installCommand(result.packageManager)}\n`
      );
    }
    return 0;
  } catch (error) {
    io.error.write(`create-monox: ${error.message}\n`);
    io.error.write('Run create-monox --help for usage.\n');
    return 1;
  }
}

function mergeOptions(config, parsed) {
  const result = { ...config };
  for (const key of ['name', 'directory', 'packageManager', 'infra', 'delivery', 'environment']) {
    if (parsed[key] !== undefined) result[key] = parsed[key];
  }
  if (parsed.workspaces.length > 0) result.workspaces = parsed.workspaces;
  if (parsed.addons.length > 0) result.addons = parsed.addons;
  result.git = parsed.git ?? config.git ?? true;
  result.install = parsed.install ?? config.install ?? true;
  return result;
}

async function collectInteractiveOptions(options, io) {
  if (!io.input.isTTY || !io.output.isTTY) throw new Error('--interactive requires an interactive terminal.');
  const prompt = createInterface({ input: io.input, output: io.output });
  try {
    const name = options.name ?? (await requiredQuestion(prompt, 'Project name: '));
    const packageManager =
      options.packageManager ?? (await defaultQuestion(prompt, 'Package manager (yarn/npm/pnpm)', 'yarn'));
    const workspaceText = options.workspaces?.length
      ? undefined
      : await defaultQuestion(
          prompt,
          'Workspaces (comma-separated name=template)',
          'api=node-fastify-api,web=react-vite-web,shared=typescript-library'
        );
    const addonText = options.addons?.length
      ? undefined
      : await defaultQuestion(prompt, 'Add-ons (comma-separated, blank for none)', '');
    const delivery =
      options.delivery ?? (await defaultQuestion(prompt, 'Delivery runtime:target', 'docker:local'));
    const environment = options.environment ?? (await defaultQuestion(prompt, 'Environment', 'development'));
    return {
      ...options,
      name,
      packageManager,
      workspaces: options.workspaces?.length ? options.workspaces : splitComma(workspaceText),
      addons: options.addons?.length ? options.addons : splitComma(addonText),
      delivery,
      environment,
    };
  } finally {
    prompt.close();
  }
}

async function requiredQuestion(prompt, label) {
  const answer = (await prompt.question(label)).trim();
  if (!answer) throw new Error(`${label.trim()} is required.`);
  return answer;
}

async function defaultQuestion(prompt, label, fallback) {
  const answer = (await prompt.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim();
  return answer || fallback;
}

function splitComma(value) {
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function readOptionValue(argv, index, argument, optionName) {
  if (argument === optionName) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) throw new Error(`${optionName} requires a value.`);
    return { value, index: index + 1 };
  }
  const prefix = `${optionName}=`;
  if (argument.startsWith(prefix)) {
    const value = argument.slice(prefix.length);
    if (!value) throw new Error(`${optionName} requires a value.`);
    return { value, index };
  }
  return undefined;
}

async function confirmGeneration(name, directory, io) {
  if (!io.input.isTTY || !io.output.isTTY)
    throw new Error('The --yes option is required in non-interactive mode.');
  const prompt = createInterface({ input: io.input, output: io.output });
  try {
    const answer = await prompt.question(`Create ${name} in ${directory}? [Y/n] `);
    return ['', 'y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    prompt.close();
  }
}

function quotePath(path) {
  return /\s/.test(path) ? JSON.stringify(path) : path;
}

function installCommand(packageManager) {
  return packageManagerShellCommand(packageManager, ['install']);
}

function helpText() {
  return `create-monox ${GENERATOR_VERSION}\n\nUsage:\n  create-monox <name> [options]\n  create-monox --config <file> [options]\n  create-monox --interactive\n\nOptions:\n  --directory <path>          Write to this empty directory\n  --package-manager <value>   yarn, npm, or pnpm (default: yarn)\n  --workspace <name=template> Repeatable workspace recipe selection\n  --addon <id>                Repeatable add-on recipe selection\n  --delivery <runtime:target> Delivery contract (default: docker:local)\n  --environment <value>       development, preview, staging, or production\n  --infra <value>             Legacy shorthand: none, docker, kubernetes, or all\n  --config <path>             Read deterministic generator options from JSON\n  --interactive               Prompt for missing selections\n  --dry-run                   Validate and list files without writing or running commands\n  --yes                       Skip confirmation; required in non-interactive mode\n  --no-git                    Do not initialize a Git repository\n  --install / --no-install    Install dependencies (default) or skip installation\n  -h, --help                  Show help\n  -v, --version               Show version\n\nWorkspace templates (${WORKSPACE_TEMPLATE_IDS.length}):\n  ${WORKSPACE_TEMPLATE_IDS.join(', ')}\n\nAdd-ons (${ADDON_IDS.length}):\n  ${ADDON_IDS.join(', ')}\n\nAvailable delivery targets:\n  ${AVAILABLE_DELIVERY_IDS.join(', ')}\n\nPlanned for 0.2.0-alpha.2 (generation fails before writes):\n  ${PLANNED_DELIVERY_IDS.join(', ')}\n`;
}

async function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return (await realpath(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}

if (await isDirectInvocation()) process.exitCode = await main();
