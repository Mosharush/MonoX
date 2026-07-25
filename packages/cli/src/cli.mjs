#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from './index.mjs';

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export { run };
