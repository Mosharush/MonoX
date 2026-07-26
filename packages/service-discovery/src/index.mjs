function normalizeUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError(`${label} must use http or https`);
  if (url.username || url.password)
    throw new TypeError(`${label} must not contain inline credentials; use an external secret reference`);
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}

export function createServiceDiscovery(config = {}) {
  const environment = String(config.environment ?? 'local');
  const services = new Map();
  for (const [name, value] of Object.entries(config.services ?? {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new TypeError(`Invalid service name: ${name}`);
    if (!value || typeof value !== 'object') throw new TypeError(`${name} requires a service definition`);
    services.set(name, {
      ...(value.internal ? { internal: normalizeUrl(value.internal, `${name}.internal`) } : {}),
      ...(value.public ? { public: normalizeUrl(value.public, `${name}.public`) } : {}),
    });
  }

  function resolve(name, options = {}) {
    const service = services.get(name);
    if (!service) throw new Error(`Unknown service: ${name}`);
    const scope = options.scope ?? 'internal';
    const selected = service[scope];
    if (!selected) throw new Error(`${name} has no ${scope} endpoint in ${environment}`);
    return new URL(options.path ?? '', selected.href.endsWith('/') ? selected : `${selected.href}/`);
  }

  return Object.freeze({
    environment,
    names: () => [...services.keys()].sort(),
    resolve,
  });
}
