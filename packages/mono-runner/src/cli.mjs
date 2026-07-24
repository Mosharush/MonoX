#!/usr/bin/env node
import { resolveRun, runWorkspaces } from './index.mjs';

const usage = `Usage: monox-dev [options]

Options:
  --all                 Run every workspace that defines the selected script
  --select api,web      Run workspaces by full or short name
  --script dev          Select a script, defaults to dev
  --dry-run             Print the execution plan without starting processes
  --help                Show this message`;

try {
  const result = await resolveRun(process.argv.slice(2));
  if (result.options.help) {
    console.log(usage);
    process.exit(0);
  }
  if (result.selected.length === 0) throw new Error('No workspaces selected');
  console.log(`MonoX will run ${result.selected.map(({ name }) => name).join(', ')}`);
  if (!result.options.dryRun) await runWorkspaces(result.root, result.selected, result.options.script);
} catch (error) {
  console.error(error.message);
  console.error(usage);
  process.exit(1);
}
