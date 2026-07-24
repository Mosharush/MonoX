function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function yamlKey(key) {
  return /^[A-Za-z0-9_./-]+$/.test(key) ? key : JSON.stringify(key);
}

function yamlScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  throw new TypeError(`Unsupported YAML scalar: ${String(value)}`);
}

function emit(value, indentation) {
  const prefix = ' '.repeat(indentation);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${prefix}[]`;
    return value
      .map((item) => {
        if (isScalar(item)) return `${prefix}- ${yamlScalar(item)}`;
        return `${prefix}-\n${emit(item, indentation + 2)}`;
      })
      .join('\n');
  }
  if (isObject(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return `${prefix}{}`;
    return entries
      .map(([key, item]) => {
        if (isScalar(item)) return `${prefix}${yamlKey(key)}: ${yamlScalar(item)}`;
        if (Array.isArray(item) && item.length === 0) return `${prefix}${yamlKey(key)}: []`;
        if (isObject(item) && Object.keys(item).length === 0) return `${prefix}${yamlKey(key)}: {}`;
        return `${prefix}${yamlKey(key)}:\n${emit(item, indentation + 2)}`;
      })
      .join('\n');
  }
  throw new TypeError(`Unsupported YAML value: ${String(value)}`);
}

export function toYaml(value) {
  if (!isObject(value)) throw new TypeError('A YAML document must be an object');
  return `${emit(value, 0)}\n`;
}

export function renderYamlDocuments(documents) {
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new TypeError('At least one Kubernetes resource is required');
  }
  return documents.map((document) => toYaml(document).trimEnd()).join('\n---\n') + '\n';
}
