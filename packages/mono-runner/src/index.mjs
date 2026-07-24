import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';

import { discoverWorkspaces, runnableWorkspaces } from '@monox/workspaces';

export function parseArguments(argv) {
  const options = { all: false, dryRun: false, script: 'dev', selected: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--all') options.all = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--script') options.script = argv[++index];
    else if (argument === '--select')
      options.selected.push(
        ...String(argv[++index] ?? '')
          .split(',')
          .filter(Boolean)
      );
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export function selectWorkspaces(workspaces, options) {
  const runnable = runnableWorkspaces(workspaces, options.script);
  if (options.all) return runnable;
  if (options.selected.length === 0) return [];
  const requested = new Set(options.selected);
  const selected = runnable.filter((workspace) => {
    const shortName = workspace.name.split('/').at(-1);
    return requested.has(workspace.name) || requested.has(shortName);
  });
  const found = new Set(selected.flatMap((workspace) => [workspace.name, workspace.name.split('/').at(-1)]));
  const missing = options.selected.filter((name) => !found.has(name));
  if (missing.length) throw new Error(`Unknown or non-runnable workspaces: ${missing.join(', ')}`);
  return selected;
}

export async function promptForWorkspaces(workspaces, script) {
  const runnable = runnableWorkspaces(workspaces, script);
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`Runnable workspaces for ${script}:`);
    runnable.forEach((workspace, index) => console.log(`  ${index + 1}. ${workspace.name}`));
    const answer = await input.question('Select numbers separated by commas, or type all: ');
    if (answer.trim().toLowerCase() === 'all') return runnable;
    const indexes = new Set(
      answer
        .split(',')
        .map((value) => Number(value.trim()) - 1)
        .filter((value) => Number.isInteger(value) && value >= 0 && value < runnable.length)
    );
    return runnable.filter((_, index) => indexes.has(index));
  } finally {
    input.close();
  }
}

function prefixLines(stream, prefix, target) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = `${pending}${chunk}`.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) target.write(`[${prefix}] ${line}\n`);
  });
  stream.on('end', () => {
    if (pending) target.write(`[${prefix}] ${pending}\n`);
  });
}

export async function runWorkspaces(root, workspaces, script) {
  const children = workspaces.map((workspace) => {
    const child = spawn('yarn', ['workspace', workspace.name, script], {
      cwd: root,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    prefixLines(child.stdout, workspace.name, process.stdout);
    prefixLines(child.stderr, workspace.name, process.stderr);
    return { child, workspace };
  });

  const stop = (signal) => children.forEach(({ child }) => child.kill(signal));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const results = await Promise.all(
      children.map(
        ({ child, workspace }) =>
          new Promise((resolve) => child.once('exit', (code, signal) => resolve({ workspace, code, signal })))
      )
    );
    const failed = results.filter(({ code }) => code !== 0);
    if (failed.length)
      throw new Error(`${failed.map(({ workspace }) => workspace.name).join(', ')} exited with errors`);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

export async function resolveRun(argv) {
  const options = parseArguments(argv);
  const discovery = await discoverWorkspaces();
  let selected = selectWorkspaces(discovery.workspaces, options);
  if (!options.all && options.selected.length === 0 && !options.help) {
    if (!process.stdin.isTTY) throw new Error('Use --all or --select in a non-interactive session');
    selected = await promptForWorkspaces(discovery.workspaces, options.script);
  }
  return { ...discovery, options, selected };
}
