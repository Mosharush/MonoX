import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseArguments } from '../src/cli.mjs';

const execFileAsync = promisify(execFile);
const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(packageDirectory, 'src', 'cli.mjs');

test('parses documented CLI options', () => {
  assert.deepEqual(
    parseArguments([
      'demo-app',
      '--directory',
      './target',
      '--package-manager=pnpm',
      '--infra',
      'kubernetes',
      '--yes',
      '--no-git',
      '--install',
    ]),
    {
      name: 'demo-app',
      directory: './target',
      packageManager: 'pnpm',
      infra: 'kubernetes',
      yes: true,
      git: false,
      install: true,
      help: false,
      version: false,
    }
  );
});

test('rejects unknown options and invalid enum values', () => {
  assert.throws(() => parseArguments(['demo-app', '--wat']), /Unknown option/);
  assert.throws(
    () => parseArguments(['demo-app', '--package-manager', 'bun']),
    /Package manager must be one of/
  );
  assert.throws(() => parseArguments(['demo-app', '--infra', 'cloud']), /Infrastructure must be one of/);
});

test('installs by default and supports an explicit no-install mode', () => {
  assert.equal(parseArguments(['demo-app']).install, true);
  assert.equal(parseArguments(['demo-app', '--no-install']).install, false);
});

test('CLI generates a project into an explicit directory', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'create-monox-cli-'));
  const destination = join(parent, 'custom-output');

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cliPath,
      'cli-app',
      '--directory',
      destination,
      '--package-manager',
      'npm',
      '--infra',
      'none',
      '--yes',
      '--no-git',
      '--no-install',
    ]);

    assert.equal(stderr, '');
    assert.match(stdout, /Created cli-app/);
    assert.match(stdout, /Next: .*npx --yes npm@10\.9\.2 install/);
    const packageJson = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
    assert.equal(packageJson.name, 'cli-app');
    assert.equal(packageJson.packageManager, 'npm@10.9.2');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('CLI prints a Node 26 safe Yarn bootstrap when installation is skipped', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'create-monox-cli-'));
  const destination = join(parent, 'yarn-output');

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cliPath,
      'yarn-app',
      '--directory',
      destination,
      '--yes',
      '--no-git',
      '--no-install',
    ]);

    assert.equal(stderr, '');
    assert.match(stdout, /npx --yes corepack@0\.35\.0 yarn install/);
    assert.doesNotMatch(stdout, /&& corepack yarn install/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('CLI requires explicit --yes when running without a TTY', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'create-monox-cli-'));
  const destination = join(parent, 'non-interactive-output');

  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath,
        'non-interactive-app',
        '--directory',
        destination,
        '--no-git',
      ]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--yes option is required in non-interactive mode/);
        return true;
      }
    );
    await assert.rejects(stat(destination), { code: 'ENOENT' });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('CLI returns a nonzero exit code for unsafe names', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, '../escape', '--yes', '--no-git']),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Project name must use/);
      return true;
    }
  );
});

test('CLI runs when installed through a package-manager symlink', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'create-monox-bin-'));
  const executable = join(parent, 'create-monox');

  try {
    await symlink(cliPath, executable);
    const { stdout, stderr } = await execFileAsync(executable, ['--version']);
    assert.equal(stderr, '');
    assert.equal(stdout.trim(), '0.1.1');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
