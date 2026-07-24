#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDeploymentConfig } from '@monox/deploy-schema';

import { renderKubernetesManifests } from './index.mjs';

function usage() {
  return [
    'Usage:',
    '  monox-kube validate <deployment.json>',
    '  monox-kube render <deployment.json> [--output <manifests.yaml>]',
  ].join('\n');
}

function parseArguments(argv) {
  const [command, input, ...rest] = argv;
  let output;
  let outputRequested = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--output') {
      outputRequested = true;
      output = rest[index + 1];
      index += 1;
    } else if (argument.startsWith('--output=')) {
      outputRequested = true;
      output = argument.slice('--output='.length);
    } else throw new TypeError(`Unknown argument: ${argument}`);
  }
  if (!['validate', 'render'].includes(command) || !input) throw new TypeError(usage());
  if (command === 'validate' && output) throw new TypeError('--output is only valid with render');
  if (outputRequested && !output) throw new TypeError('--output requires a file path');
  return { command, input, output };
}

async function loadConfig(file) {
  const source = await readFile(file, 'utf8');
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new SyntaxError(`Cannot parse ${file}: ${error.message}`);
  }
}

export async function run(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const { command, input, output } = parseArguments(argv);
  const inputPath = path.resolve(input);
  const config = await loadConfig(inputPath);

  if (command === 'validate') {
    const result = validateDeploymentConfig(config);
    if (!result.valid) {
      const details = result.errors.map((error) => `- ${error.path}: ${error.message}`).join('\n');
      throw new TypeError(`Invalid deployment configuration:\n${details}`);
    }
    stdout.write(`Valid deployment configuration: ${inputPath}\n`);
    return { inputPath, config: result.value };
  }

  const yaml = renderKubernetesManifests(config);
  if (output) {
    const outputPath = path.resolve(output);
    await writeFile(outputPath, yaml, { encoding: 'utf8', flag: 'w' });
    stdout.write(`Rendered Kubernetes manifests: ${outputPath}\n`);
    return { inputPath, outputPath, yaml };
  }
  stdout.write(yaml);
  return { inputPath, yaml };
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
