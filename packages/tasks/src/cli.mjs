#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatPlan, planRepository, executePlan } from './index.mjs';

export function parseArguments(argv) {
  const options = {
    command: argv[0],
    root: process.cwd(),
    graphPath: 'monox.tasks.json',
    base: 'origin/main',
    head: 'HEAD',
    changedPaths: undefined,
    selectAll: false,
    cacheDir: undefined,
    json: false,
    fullGateScript: 'check',
    help: false,
  };
  const changed = [];
  let sawChanged = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') options.root = argv[++index];
    else if (argument === '--graph') options.graphPath = argv[++index];
    else if (argument === '--base') options.base = argv[++index];
    else if (argument === '--head') options.head = argv[++index];
    else if (argument === '--cache-dir') options.cacheDir = argv[++index];
    else if (argument === '--full-gate-script') options.fullGateScript = argv[++index];
    else if (argument === '--changed') {
      sawChanged = true;
      const value = argv[++index];
      if (value) changed.push(value);
    } else if (argument === '--all') options.selectAll = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (sawChanged) options.changedPaths = changed;
  return options;
}

export const helpText = `Usage:
  monox-tasks plan [--root dir] [--graph monox.tasks.json] [--base ref] [--head ref]
                   [--changed path]... [--all] [--cache-dir dir] [--json]
  monox-tasks run  [same selection flags] [--full-gate-script check]

plan explains whether each task would run, skip, or restore and does not execute tasks.
run performs that plan. Cache entries stay in the local .monox/cache/tasks directory.
Invalid graphs fail open: they run every declared task, or the full gate when the
document cannot be expanded, and they do not restore cache entries.
`;

export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const write = (stream, text) => stream.write(text.endsWith('\n') ? text : `${text}\n`);
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    write(stderr, error.message);
    return 1;
  }
  if (options.help || !options.command) {
    write(stdout, helpText);
    return 0;
  }
  if (options.command !== 'plan' && options.command !== 'run') {
    write(stderr, `Unknown command: ${options.command}`);
    return 1;
  }
  if (options.fullGateScript !== undefined && !/^[A-Za-z0-9:_-]{1,64}$/.test(options.fullGateScript ?? '')) {
    write(stderr, 'Full gate script name is invalid');
    return 1;
  }
  const plan = await planRepository({
    root: options.root,
    graphPath: options.graphPath,
    base: options.base,
    head: options.head,
    changedPaths: options.changedPaths,
    selectAll: options.selectAll,
    cacheDir: options.cacheDir,
  });
  if (options.json) write(stdout, JSON.stringify(plan, null, 2));
  else write(stdout, formatPlan(plan));
  if (plan.failOpen) write(stderr, `Task graph failed open: ${plan.reason}`);
  if (options.command === 'plan') return 0;
  try {
    await executePlan(plan, {
      root: path.resolve(options.root),
      cacheDir: options.cacheDir,
      fullGateScript: options.fullGateScript,
    });
  } catch (error) {
    write(stderr, error.message);
    return 1;
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
