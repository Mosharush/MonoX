import { spawn } from 'node:child_process';

import { discoverWorkspaces, runnableWorkspaces } from '../packages/workspaces/src/index.mjs';

const script = process.argv[2];
if (!script) throw new Error('Usage: node scripts/run-workspaces.mjs <script>');

const { root, workspaces } = await discoverWorkspaces();
const runnable = runnableWorkspaces(workspaces, script);

for (const workspace of runnable) {
  console.log(`Running ${script} in ${workspace.name}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn('yarn', ['workspace', workspace.name, script], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) process.exit(code);
}
