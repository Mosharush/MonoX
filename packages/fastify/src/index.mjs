import { createAppRuntime } from '@monox/app-runtime';

export function installMonoXFastify(app, options = {}) {
  if (!app || typeof app.get !== 'function') throw new TypeError('A Fastify-compatible instance is required');
  const runtime = options.runtime ?? createAppRuntime(options);
  const route = (path, handler) => app.get(path, { logLevel: 'silent' }, handler);
  route('/healthz', async (_request, reply) =>
    reply.code(runtime.health().ready ? 200 : 503).send(runtime.health())
  );
  route('/readyz', async (_request, reply) =>
    reply.code(runtime.health().ready ? 200 : 503).send({ ready: runtime.health().ready })
  );
  route('/livez', async (_request, reply) =>
    reply.code(runtime.health().live ? 200 : 503).send({ live: runtime.health().live })
  );
  route('/metrics', async (_request, reply) =>
    reply.type('text/plain; version=0.0.4; charset=utf-8').send(runtime.telemetry.prometheus())
  );
  if (typeof app.addHook === 'function') {
    app.addHook('onReady', async () => runtime.setReady(true));
    app.addHook('onClose', async () => runtime.setReady(false));
  }
  return runtime;
}
