import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect as connectTcp } from 'node:net';
import test from 'node:test';

import {
  assertRemoteProxyAbsentFromProductionArtifacts,
  canonicalIp,
  createPinnedLookup,
  createPinnedTransport,
  createRemoteProxyCloudapter,
  disabledRemoteProxyConfig,
  forwardThroughProxy,
  isBlockedAddress,
  remoteProxyCredentialFindings,
  startRemoteProxyServer,
  validateRemoteProxyConfig,
} from '../src/index.mjs';

const devContext = {
  environment: 'development',
  nodeEnv: 'development',
  production: false,
};

function enabledConfig(allowlist = [entry()]) {
  return {
    schemaVersion: '1',
    enabled: true,
    listen: { host: '127.0.0.1', port: 0 },
    allowlist,
    credentialForwarding: 'never',
  };
}

function entry(overrides = {}) {
  return { protocol: 'https', host: 'dev.example.test', port: 443, ...overrides };
}

function publicLookup(address = '8.8.8.8', family = 4) {
  return async () => [{ address, family }];
}

function adapterContext(overrides = {}) {
  return {
    config: {
      project: { name: 'example' },
      environments: {
        development: { production: false },
        production: { production: true, protected: true },
      },
    },
    environment: 'development',
    nodeEnv: 'development',
    sourceDigest: 'sha256:source',
    targetStateDigest: 'sha256:state',
    target: {
      id: 'local',
      provider: 'generic',
      provisioner: 'none',
      transport: 'local',
      runtime: 'docker',
    },
    workloads: [],
    ...overrides,
  };
}

function proxyRequest(port, method, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path: target, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('remote proxy config is disabled by default and rejects credential fields', async () => {
  const config = disabledRemoteProxyConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.credentialForwarding, 'never');
  assert.deepEqual(config.allowlist, []);
  assert.deepEqual(remoteProxyCredentialFindings(config), []);
  assert.equal(validateRemoteProxyConfig(config).valid, true);
  const repositoryFixture = JSON.parse(
    await readFile(new URL('../../../infra/local/remote-proxy.json', import.meta.url), 'utf8')
  );
  assert.deepEqual(repositoryFixture, config);

  const forwarded = validateRemoteProxyConfig({ ...config, credentialForwarding: 'always' });
  assert.equal(forwarded.valid, false);
  const secretField = validateRemoteProxyConfig({ ...enabledConfig(), apiKey: 'prod-token' });
  assert.equal(secretField.valid, false);
  assert.equal(
    validateRemoteProxyConfig({
      ...enabledConfig(),
      allowlist: [entry({ host: '10.0.0.5' })],
    }).valid,
    false
  );
  assert.equal(
    validateRemoteProxyConfig({
      ...enabledConfig(),
      allowlist: [entry({ host: '*.example.test' })],
    }).valid,
    false
  );
  assert.equal(
    validateRemoteProxyConfig({
      ...enabledConfig(),
      listen: { host: '0.0.0.0', port: 8080 },
    }).valid,
    false
  );
});

test('denies private, mapped, metadata, and NAT64 addresses', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.1.20',
    '172.16.0.4',
    '100.100.100.200',
    '::1',
    'fd00:ec2::254',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1',
    '64:ff9b::a00:1',
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('2001:4860:4860::8888'), false);
  assert.equal(canonicalIp('2001:4860:4860:0:0:0:0:8888'), '2001:4860:4860::8888');
  assert.equal(canonicalIp('::ffff:127.0.0.1'), '::ffff:7f00:1');
});

test('denies destinations that miss the allowlist, including obfuscated loopback', async () => {
  const calls = [];
  const transport = async (operation) => {
    calls.push(operation);
    return { status: 204, headers: {}, body: '' };
  };
  const denied = [
    'https://evil.example/secret',
    'https://dev.example.test.evil.example/secret',
    'http://dev.example.test/secret',
    'https://dev.example.test:8443/secret',
    'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'https://user:secret@dev.example.test/path',
    'https://dev.example.test/path?token=super-secret',
    'http://[::ffff:127.0.0.1]/',
  ];
  for (const url of denied) {
    const response = await forwardThroughProxy({
      config: enabledConfig(),
      method: 'GET',
      url,
      lookup: publicLookup(),
      transport,
      context: devContext,
    });
    assert.equal(response.status, 403, url);
    assert.doesNotMatch(response.body, /169\.254|secret|10\.|127\.0\.0\.1/);
  }
  assert.equal(calls.length, 0);
});

test('strips credential headers and refuses a DNS answer that changes to a private address', async () => {
  const calls = [];
  let answers = [{ address: '8.8.8.8', family: 4 }];
  const transport = async (operation) => {
    calls.push(operation);
    return {
      status: 200,
      headers: { 'content-type': 'text/plain', 'set-cookie': 'session=secret' },
      body: 'ok',
    };
  };
  const first = await forwardThroughProxy({
    config: enabledConfig(),
    method: 'GET',
    url: 'https://dev.example.test/item',
    headers: { authorization: 'Bearer super-secret', cookie: 'session=secret', 'x-request-id': 'abc' },
    lookup: async () => answers,
    transport,
    context: devContext,
  });
  assert.equal(first.status, 200);
  assert.equal(first.body, 'ok');
  assert.equal(first.headers['set-cookie'], undefined);
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[0].headers.cookie, undefined);
  assert.equal(calls[0].headers['x-request-id'], 'abc');
  assert.equal(calls[0].headers.host, 'dev.example.test');
  assert.deepEqual(calls[0].addresses, [{ address: '8.8.8.8', family: 4 }]);

  answers = [
    { address: '8.8.8.8', family: 4 },
    { address: '10.0.0.8', family: 4 },
  ];
  const mixed = await forwardThroughProxy({
    config: enabledConfig(),
    method: 'GET',
    url: 'https://dev.example.test/item',
    lookup: async () => answers,
    transport,
    context: devContext,
  });
  assert.equal(mixed.status, 403);

  answers = [{ address: '10.0.0.8', family: 4 }];
  const rebound = await forwardThroughProxy({
    config: enabledConfig(),
    method: 'GET',
    url: 'https://dev.example.test/item',
    lookup: async () => answers,
    transport,
    context: devContext,
  });
  assert.equal(rebound.status, 403);
  assert.equal(calls.length, 1);
});

test('does not follow redirects and rejects redirect bypass targets', async () => {
  const calls = [];
  const cases = [
    [
      'https://dev.example.test/http://169.254.169.254/latest/meta-data/',
      'http://169.254.169.254/latest/meta-data/',
    ],
    ['https://dev.example.test/http://127.0.0.1/admin', 'http://127.0.0.1/admin'],
    ['https://dev.example.test/https://evil.example/take', 'https://evil.example/take'],
    [
      'https://dev.example.test/https://user:secret@dev.example.test/next',
      'https://user:secret@dev.example.test/next',
    ],
    ['https://dev.example.test/file:///etc/passwd', 'file:///etc/passwd'],
    ['https://dev.example.test///169.254.169.254/latest', '//169.254.169.254/latest'],
    ['https://dev.example.test/http://10.0.0.5/', 'http://10.0.0.5/'],
    ['https://dev.example.test/https://dev.example.test:8443/next', 'https://dev.example.test:8443/next'],
    [
      'https://dev.example.test/https://dev.example.test.evil.example/',
      'https://dev.example.test.evil.example/',
    ],
  ];
  for (const [url, location] of cases) {
    const response = await forwardThroughProxy({
      config: enabledConfig(),
      method: 'GET',
      url,
      lookup: async (hostname) => {
        if (hostname !== 'dev.example.test') throw new Error(`unexpected lookup ${hostname}`);
        return [{ address: '8.8.8.8', family: 4 }];
      },
      transport: async (operation) => {
        calls.push(operation.url);
        return { status: 302, headers: { location }, body: `follow ${location}` };
      },
      context: devContext,
    });
    assert.equal(response.status, 403, location);
    assert.equal(response.headers.location, undefined);
    assert.equal(response.followed, false);
    assert.doesNotMatch(response.body, /169\.254|secret|127\.0\.0\.1|evil\.example|10\.0\.0\.5|passwd/);
  }
  assert.equal(calls.length, cases.length);

  const safe = await forwardThroughProxy({
    config: enabledConfig(),
    method: 'GET',
    url: 'https://dev.example.test/start',
    lookup: publicLookup(),
    transport: async (operation) => {
      calls.push(operation.url);
      return { status: 302, headers: { location: '/next' }, body: 'next' };
    },
    context: devContext,
  });
  assert.equal(safe.status, 302);
  assert.equal(safe.followed, false);
  assert.equal(safe.headers.location, 'https://dev.example.test/next');
  assert.equal(calls.at(-1), 'https://dev.example.test/start');
  assert.equal(calls.length, cases.length + 1);

  let phase = 'public';
  const rebound = await forwardThroughProxy({
    config: enabledConfig(),
    method: 'GET',
    url: 'https://dev.example.test/rebind',
    lookup: async () =>
      phase === 'public' ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '10.1.1.1', family: 4 }],
    transport: async (operation) => {
      calls.push(operation.url);
      phase = 'private';
      return { status: 302, headers: { location: 'https://dev.example.test/after' }, body: '' };
    },
    context: devContext,
  });
  assert.equal(rebound.status, 403);
  assert.equal(rebound.headers.location, undefined);
  assert.equal(calls.at(-1), 'https://dev.example.test/rebind');
});

test('pins the checked address and does not dial a blocked one', async () => {
  const lookup = createPinnedLookup('8.8.8.8', 4);
  const pinned = await new Promise((resolve) => {
    lookup('rebound.example', {}, (error, address, family) => resolve({ error, address, family }));
  });
  assert.deepEqual(pinned, { error: null, address: '8.8.8.8', family: 4 });

  let seen;
  const transport = createPinnedTransport({
    requestImpl(operation) {
      seen = {
        hostname: operation.hostname,
        address: operation.address,
        family: operation.family,
      };
      return Promise.resolve({ status: 204, headers: {}, body: '' });
    },
  });
  const response = await transport({
    method: 'GET',
    url: 'https://dev.example.test/item',
    headers: { host: 'dev.example.test' },
    addresses: [{ address: '8.8.8.8', family: 4 }],
  });
  assert.equal(response.status, 204);
  assert.deepEqual(seen, {
    hostname: 'dev.example.test',
    address: '8.8.8.8',
    family: 4,
  });

  let called = 0;
  const blocked = createPinnedTransport({
    requestImpl() {
      called += 1;
      return Promise.resolve({ status: 200, headers: {}, body: '' });
    },
  });
  await assert.rejects(
    () =>
      blocked({
        method: 'GET',
        url: 'http://127.0.0.1/',
        headers: {},
        addresses: [{ address: '127.0.0.1', family: 4 }],
      }),
    /blocked address/
  );
  assert.equal(called, 0);
});

test('serves only allowlisted absolute destinations on loopback', async () => {
  const calls = [];
  const proxy = await startRemoteProxyServer({
    config: enabledConfig(),
    lookup: publicLookup(),
    transport: async (operation) => {
      calls.push(operation);
      if (operation.url.endsWith('/redirect')) {
        return {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          body: 'http://169.254.169.254/latest/meta-data/',
        };
      }
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' };
    },
    context: devContext,
  });
  try {
    const denied = await proxyRequest(proxy.address.port, 'GET', 'https://evil.example/secret');
    assert.equal(denied.status, 403);
    const metadata = await proxyRequest(
      proxy.address.port,
      'GET',
      'http://169.254.169.254/latest/meta-data/'
    );
    assert.equal(metadata.status, 403);
    const origin = await proxyRequest(proxy.address.port, 'GET', '/local');
    assert.equal(origin.status, 403);
    const connect = await new Promise((resolve, reject) => {
      const socket = connectTcp(proxy.address.port, '127.0.0.1', () => {
        socket.write('CONNECT dev.example.test:443 HTTP/1.1\r\nHost: dev.example.test:443\r\n\r\n');
      });
      const chunks = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.on('error', reject);
    });
    assert.match(connect, /^HTTP\/1\.1 405/);
    const redirect = await proxyRequest(proxy.address.port, 'GET', 'https://dev.example.test/redirect', {
      authorization: 'Bearer super-secret',
      cookie: 'session=secret',
    });
    assert.equal(redirect.status, 403);
    assert.equal(redirect.headers.location, undefined);
    assert.doesNotMatch(redirect.body, /169\.254\.169\.254/);
    const allowed = await proxyRequest(proxy.address.port, 'GET', 'https://dev.example.test/ok');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, 'ok');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.authorization, undefined);
    assert.equal(calls[0].headers.cookie, undefined);
    assert.equal(new URL(calls[0].url).hostname, 'dev.example.test');
  } finally {
    await proxy.close();
  }
});

test('stays disabled until explicitly enabled and never listens for production', async () => {
  const adapter = createRemoteProxyCloudapter();
  const input = adapterContext();
  const doctor = await adapter.doctor(input);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.checks.find((check) => check.id === 'enabled').status, 'pass');
  const plan = await adapter.plan(input);
  assert.equal(plan.metadata.enabled, false);
  assert.equal(plan.actions[0].operation, 'disabled');
  const receipt = await adapter.apply(plan, input);
  assert.equal(receipt.result.status, 'disabled');
  assert.equal(receipt.result.changed, false);

  await assert.rejects(
    () => startRemoteProxyServer({ config: disabledRemoteProxyConfig(), context: devContext }),
    /disabled/
  );

  const production = adapterContext({
    environment: 'production',
    nodeEnv: 'production',
    remoteProxy: enabledConfig(),
    target: {
      id: 'cluster',
      provider: 'generic',
      provisioner: 'none',
      transport: 'kubernetes-api',
      runtime: 'kubernetes',
    },
  });
  const validation = await adapter.validate(production);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /production/);
  await assert.rejects(() => adapter.plan(production), /production/);
  await assert.rejects(
    () =>
      startRemoteProxyServer({
        config: enabledConfig(),
        context: { environment: 'production', nodeEnv: 'development' },
      }),
    /production/
  );

  const local = adapterContext({
    remoteProxy: enabledConfig(),
    lookup: publicLookup(),
    transport: async () => ({ status: 204, headers: {}, body: '' }),
  });
  const enabledPlan = await adapter.plan(local);
  assert.equal(enabledPlan.metadata.enabled, true);
  assert.equal(enabledPlan.metadata.production, 'forbidden');
  assert.equal(enabledPlan.metadata.redirects, 'not-followed');
  const rendered = await adapter.render(enabledPlan, { environment: 'production', nodeEnv: 'production' });
  assert.match(rendered.artifacts[0].content, /"enabled": false/);
  assert.match(rendered.warnings[0], /production/);
  assert.equal(remoteProxyCredentialFindings(JSON.parse(rendered.artifacts[0].content)).length, 0);
  const listening = await adapter.apply(enabledPlan, local);
  assert.equal(listening.result.status, 'listening');
  const destroyed = await adapter.destroy({ confirm: 'example/development/local', plan: enabledPlan }, local);
  assert.equal(destroyed.result.status, 'stopped');
});

test('the delivery CLI does not register the remote proxy', async () => {
  const source = await readFile(new URL('../../cli/src/index.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /cloudapter-remote-proxy|createRemoteProxyCloudapter/);
});

test('production artifacts cannot carry an enabled proxy or credentials', () => {
  assert.equal(
    assertRemoteProxyAbsentFromProductionArtifacts({
      'infra/local/remote-proxy.json': `${JSON.stringify(disabledRemoteProxyConfig(), null, 2)}\n`,
      'infra/kubernetes/workloads.yaml': '# no proxy\n',
      'infra/docker/api.Dockerfile': 'FROM scratch\n',
    }),
    true
  );
  assert.throws(
    () =>
      assertRemoteProxyAbsentFromProductionArtifacts({
        'infra/local/remote-proxy.json': `${JSON.stringify(enabledConfig(), null, 2)}\n`,
      }),
    /must stay disabled/
  );
  assert.throws(
    () =>
      assertRemoteProxyAbsentFromProductionArtifacts({
        'infra/kubernetes/workloads.yaml': 'remote-proxy: enabled\n',
      }),
    /must not include the local remote proxy/
  );
});
