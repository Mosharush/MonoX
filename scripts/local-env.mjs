#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArguments(argv) {
  const options = { output: path.join(repositoryRoot, 'infra', 'local', '.env') };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') {
      const value = argv[index + 1];
      if (!value) throw new Error('--output requires a path');
      options.output = path.resolve(value);
      index += 1;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function secret() {
  return randomBytes(32).toString('base64url');
}

export async function createLocalEnvironment(output) {
  const destination = path.resolve(output);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink()) throw new Error(`Refusing symlink destination: ${destination}`);
    throw new Error(`Refusing to overwrite existing local environment: ${destination}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const contents = [
    'POSTGRES_DB=monox',
    'POSTGRES_USER=monox',
    `POSTGRES_PASSWORD=${secret()}`,
    'POSTGRES_PORT=5432',
    `REDIS_PASSWORD=${secret()}`,
    'REDIS_PORT=6379',
    'OLLAMA_PORT=11434',
    'API_PORT=3000',
    'WEB_PORT=3001',
    '',
  ].join('\n');
  await writeFile(destination, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return destination;
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const options = parseArguments(process.argv.slice(2));
  const output = await createLocalEnvironment(options.output);
  process.stdout.write(`Created ${output}\n`);
}
