function parseVersion(version) {
  const match = String(version)
    .trim()
    .match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!match) {
    throw new Error(`Invalid Node.js version: ${version}`);
  }

  return match.slice(1).map((part) => Number(part ?? 0));
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }

  return 0;
}

function matchesComparator(version, comparator) {
  const match = comparator.match(/^(>=|<=|>|<|=)?(v?\d+(?:\.\d+){0,2})$/);
  if (!match) {
    throw new Error(`Unsupported Node.js version comparator: ${comparator}`);
  }

  const comparison = compareVersions(version, match[2]);
  const operator = match[1] ?? '=';
  return {
    '>=': comparison >= 0,
    '<=': comparison <= 0,
    '>': comparison > 0,
    '<': comparison < 0,
    '=': comparison === 0,
  }[operator];
}

export function satisfiesNodeVersionRange(version, range) {
  parseVersion(version);

  return String(range)
    .split('||')
    .some((clause) => {
      const comparators = clause.trim().split(/\s+/).filter(Boolean);
      return comparators.length > 0 && comparators.every((entry) => matchesComparator(version, entry));
    });
}
