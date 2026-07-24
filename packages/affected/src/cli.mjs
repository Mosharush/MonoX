#!/usr/bin/env node
import { affectedFromGit } from './index.mjs';

let base = 'origin/main';
let head = 'HEAD';
let json = false;

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === '--base') base = process.argv[++index];
  else if (argument === '--head') head = process.argv[++index];
  else if (argument === '--json') json = true;
  else if (argument === '--help') {
    console.log('Usage: monox-affected [--base ref] [--head ref] [--json]');
    process.exit(0);
  } else throw new Error(`Unknown argument: ${argument}`);
}

const result = await affectedFromGit({ base, head });
if (json) console.log(JSON.stringify(result, null, 2));
else result.workspaces.forEach((workspace) => console.log(workspace));

if (result.failOpen) console.warn(`Affected calculation failed open: ${result.error}`);
