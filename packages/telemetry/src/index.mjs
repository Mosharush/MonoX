function metricName(value) {
  const name = String(value ?? '');
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new TypeError(`Invalid metric name: ${value}`);
  return name;
}

function labelsKey(labels = {}) {
  return JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));
}

function renderLabels(key) {
  const entries = JSON.parse(key);
  if (entries.length === 0) return '';
  return `{${entries
    .map(([name, value]) => `${name}="${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',')}}`;
}

export function createTelemetry(options = {}) {
  const metrics = new Map();
  const observe = options.observe ?? (() => {});

  function record(type, name, value, labels = {}) {
    const normalizedName = metricName(name);
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new TypeError(`${normalizedName} requires a finite number`);
    const metric = metrics.get(normalizedName) ?? { type, values: new Map() };
    if (metric.type !== type)
      throw new TypeError(`${normalizedName} is already registered as ${metric.type}`);
    const key = labelsKey(labels);
    const current = metric.values.get(key) ?? { count: 0, sum: 0, value: 0 };
    if (type === 'counter') current.value += numeric;
    else if (type === 'gauge') current.value = numeric;
    else {
      current.count += 1;
      current.sum += numeric;
    }
    metric.values.set(key, current);
    metrics.set(normalizedName, metric);
    observe({ type, name: normalizedName, value: numeric, labels: { ...labels } });
  }

  function prometheus() {
    const lines = [];
    for (const [name, metric] of [...metrics].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`# TYPE ${name} ${metric.type === 'histogram' ? 'summary' : metric.type}`);
      for (const [key, sample] of [...metric.values].sort(([left], [right]) => left.localeCompare(right))) {
        const suffix = renderLabels(key);
        if (metric.type === 'histogram') {
          lines.push(`${name}_count${suffix} ${sample.count}`);
          lines.push(`${name}_sum${suffix} ${sample.sum}`);
        } else lines.push(`${name}${suffix} ${sample.value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  return Object.freeze({
    increment: (name, value = 1, labels) => record('counter', name, value, labels),
    gauge: (name, value, labels) => record('gauge', name, value, labels),
    histogram: (name, value, labels) => record('histogram', name, value, labels),
    prometheus,
    snapshot: () => structuredClone(Object.fromEntries(metrics)),
  });
}
