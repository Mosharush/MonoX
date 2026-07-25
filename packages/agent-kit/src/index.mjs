import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function stringList(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new TypeError(`${label} must be a non-empty string array`);
  }
  return [...new Set(values.map((value) => value.trim()))];
}

export function normalizeAgentContract(input) {
  if (!input || typeof input !== 'object') throw new TypeError('Agent contract must be an object');
  const project = String(input.project ?? '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(project)) throw new TypeError('Invalid project name');
  const zones = Object.fromEntries(
    Object.entries(input.zones ?? {}).map(([name, rules]) => [name, stringList(rules, `zones.${name}`)])
  );
  if (Object.keys(zones).length === 0) throw new TypeError('At least one repository zone is required');
  return {
    schemaVersion: '1',
    project,
    objective: String(input.objective ?? `Keep ${project} explicit, reproducible and safe.`).trim(),
    zones,
    commands: Object.fromEntries(
      Object.entries(input.commands ?? {}).map(([name, command]) => [name, String(command).trim()])
    ),
    prohibited: stringList(input.prohibited ?? ['Do not commit secrets.'], 'prohibited'),
  };
}

export function agentContractDigest(contract) {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

export function renderAgentContract(input) {
  const contract = normalizeAgentContract(input);
  const digest = agentContractDigest(contract);
  const lines = [
    `# ${contract.project} agent contract`,
    '',
    `Generated from the MonoX project contract. Source digest: \`${digest}\`.`,
    '',
    '## Objective',
    '',
    contract.objective,
    '',
    '## Repository zones',
    '',
  ];
  for (const [zone, rules] of Object.entries(contract.zones)) {
    lines.push(`### \`${zone}\``, '', ...rules.map((rule) => `- ${rule}`), '');
  }
  if (Object.keys(contract.commands).length) {
    lines.push('## Commands', '');
    for (const [name, command] of Object.entries(contract.commands)) lines.push(`- ${name}: \`${command}\``);
    lines.push('');
  }
  lines.push('## Hard boundaries', '', ...contract.prohibited.map((rule) => `- ${rule}`), '');
  return { contract, digest, markdown: `${lines.join('\n')}\n` };
}

function safeDestination(root, relative) {
  const normalized = path.normalize(relative);
  if (
    path.isAbsolute(normalized) ||
    normalized.startsWith('..') ||
    normalized.includes(`${path.sep}..${path.sep}`)
  ) {
    throw new TypeError(`Unsafe agent output path: ${relative}`);
  }
  return path.join(root, normalized);
}

export async function writeAgentContract(root, input, options = {}) {
  const rendered = renderAgentContract(input);
  const targets = options.targets ?? ['AGENTS.md'];
  for (const relative of targets) {
    const destination = safeDestination(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, rendered.markdown, {
      encoding: 'utf8',
      flag: options.overwrite ? 'w' : 'wx',
    });
  }
  return { ...rendered, targets: [...targets] };
}
