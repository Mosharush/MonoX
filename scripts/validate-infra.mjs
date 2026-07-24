import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compose = path.join(root, 'infra', 'local', 'docker-compose.yml');
const deployment = path.join(root, 'infra', 'kubernetes', 'example.deployment.json');
const dockerfile = path.join(root, 'infra', 'docker', 'Dockerfile.node');
const entrypoint = path.join(root, 'infra', 'docker', 'entrypoint.sh');
const renderer = path.join(root, 'packages', 'kube-renderer', 'src', 'cli.mjs');

await Promise.all([compose, deployment, dockerfile, entrypoint, renderer].map((file) => access(file)));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
  if (result.error?.code === 'ENOENT' && options.optional) {
    console.warn(`${command} is not installed; ${options.label ?? 'validation'} skipped`);
    return result;
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result;
}

const composeText = await readFile(compose, 'utf8');
if (/\b(?:password|secret|token):\s*(?!\$\{|example|change-me|local-only)/i.test(composeText)) {
  throw new Error('Compose file contains a non-placeholder credential-like value');
}

const dockerfileText = await readFile(dockerfile, 'utf8');
if (!/yarn install --immutable/.test(dockerfileText)) {
  throw new Error('Docker image installation must use the committed Yarn lockfile immutably');
}
if (!/^USER\s+(?!0\b|root\b)/m.test(dockerfileText)) {
  throw new Error('Docker runtime must declare a non-root user');
}

run(process.execPath, [renderer, 'validate', deployment]);
const rendered = run(process.execPath, [renderer, 'render', deployment]).stdout;
if (!/kind: "Deployment"/.test(rendered) || !/runAsNonRoot: true/.test(rendered)) {
  throw new Error('Rendered Kubernetes output is missing the workload or restricted security context');
}
if (/\b(?:password|private[_-]?key|secret[_-]?key|token):/i.test(rendered)) {
  throw new Error('Rendered Kubernetes output contains a credential-like field');
}

run('shellcheck', [entrypoint], { optional: true, label: 'entrypoint lint' });
const composePlugin = spawnSync('docker', ['compose', 'version'], { cwd: root, encoding: 'utf8' });
if (composePlugin.status === 0) {
  run('docker', ['compose', '-f', compose, '--profile', 'local', 'config', '--quiet']);
} else {
  run('docker-compose', ['-f', compose, '--profile', 'local', 'config', '--quiet'], {
    optional: true,
    label: 'Compose validation',
  });
}

console.log('Infrastructure validation passed.');
