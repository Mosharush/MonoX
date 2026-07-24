#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateProject, INFRA_OPTIONS, PACKAGE_MANAGERS, resolveDestination } from './generator.mjs';

const VERSION = '0.1.1';

export function parseArguments(argv) {
  const result = {
    name: undefined,
    directory: undefined,
    packageManager: 'yarn',
    infra: 'all',
    yes: false,
    git: true,
    install: true,
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

    if (argument === '--help' || argument === '-h') {
      result.help = true;
      continue;
    }

    if (argument === '--version' || argument === '-v') {
      result.version = true;
      continue;
    }

    if (argument === '--yes') {
      result.yes = true;
      continue;
    }

    if (argument === '--no-git') {
      result.git = false;
      continue;
    }

    if (argument === '--install') {
      result.install = true;
      continue;
    }

    if (argument === '--no-install') {
      result.install = false;
      continue;
    }

    const directory = readOptionValue(argv, index, argument, '--directory');
    if (directory) {
      result.directory = directory.value;
      index = directory.index;
      continue;
    }

    const packageManager = readOptionValue(argv, index, argument, '--package-manager');
    if (packageManager) {
      result.packageManager = packageManager.value;
      index = packageManager.index;
      continue;
    }

    const infra = readOptionValue(argv, index, argument, '--infra');
    if (infra) {
      result.infra = infra.value;
      index = infra.index;
      continue;
    }

    if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    }

    positionals.push(argument);
  }

  if (positionals.length > 1) {
    throw new Error('Expected one project name.');
  }

  result.name = positionals[0];

  if (!result.help && !result.version && !result.name) {
    throw new Error('A project name is required.');
  }

  if (!PACKAGE_MANAGERS.includes(result.packageManager)) {
    throw new Error(`Package manager must be one of: ${PACKAGE_MANAGERS.join(', ')}.`);
  }

  if (!INFRA_OPTIONS.includes(result.infra)) {
    throw new Error(`Infrastructure must be one of: ${INFRA_OPTIONS.join(', ')}.`);
  }

  return result;
}

export async function main(
  argv = process.argv.slice(2),
  io = { input: process.stdin, output: process.stdout, error: process.stderr }
) {
  let options;

  try {
    options = parseArguments(argv);

    if (options.help) {
      io.output.write(helpText());
      return 0;
    }

    if (options.version) {
      io.output.write(`${VERSION}\n`);
      return 0;
    }

    const directory = resolveDestination(options);
    const approved = options.yes || (await confirmGeneration(options.name, directory, io));

    if (!approved) {
      io.output.write('Cancelled.\n');
      return 0;
    }

    const result = await generateProject({ ...options, directory });

    io.output.write(`Created ${result.name} in ${result.directory}\n`);
    io.output.write(`Package manager: ${result.packageManager}\n`);
    io.output.write(`Infrastructure: ${result.infra}\n`);
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

function readOptionValue(argv, index, argument, optionName) {
  if (argument === optionName) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new Error(`${optionName} requires a value.`);
    }

    return { value, index: index + 1 };
  }

  const prefix = `${optionName}=`;
  if (argument.startsWith(prefix)) {
    const value = argument.slice(prefix.length);
    if (value === '') {
      throw new Error(`${optionName} requires a value.`);
    }

    return { value, index };
  }

  return undefined;
}

async function confirmGeneration(name, directory, io) {
  if (!io.input.isTTY || !io.output.isTTY) {
    throw new Error('The --yes option is required in non-interactive mode.');
  }

  const prompt = createInterface({ input: io.input, output: io.output });
  try {
    const answer = await prompt.question(`Create ${name} in ${directory}? [Y/n] `);
    return (
      answer.trim() === '' || answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
    );
  } finally {
    prompt.close();
  }
}

function quotePath(path) {
  return /\s/.test(path) ? JSON.stringify(path) : path;
}

function installCommand(packageManager) {
  return packageManager === 'npm' ? 'npm install' : `corepack ${packageManager} install`;
}

function helpText() {
  return `create-monox ${VERSION}

Usage:
  create-monox <name> [options]

Options:
  --directory <path>          Write to this empty directory
  --package-manager <value>   yarn, npm, or pnpm (default: yarn)
  --infra <value>             none, docker, kubernetes, or all (default: all)
  --yes                       Skip confirmation; required in non-interactive mode
  --no-git                    Do not initialize a Git repository
  --install                   Install dependencies and create a lockfile (default)
  --no-install                Skip dependency installation and lockfile creation
  -h, --help                  Show help
  -v, --version               Show version
`;
}

async function isDirectInvocation() {
  if (!process.argv[1]) return false;

  try {
    return (await realpath(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}

if (await isDirectInvocation()) {
  process.exitCode = await main();
}
