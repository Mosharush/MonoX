import assert from 'node:assert/strict';
import test from 'node:test';

import { createTelemetry } from '../src/index.mjs';

test('records deterministic counters, gauges and summaries', () => {
  const telemetry = createTelemetry();
  telemetry.increment('http_requests_total', 1, { route: '/healthz' });
  telemetry.increment('http_requests_total', 2, { route: '/healthz' });
  telemetry.gauge('queue_depth', 4);
  telemetry.histogram('request_duration_seconds', 0.2);
  telemetry.histogram('request_duration_seconds', 0.4);
  assert.equal(
    telemetry.prometheus(),
    '# TYPE http_requests_total counter\n' +
      'http_requests_total{route="/healthz"} 3\n' +
      '# TYPE queue_depth gauge\n' +
      'queue_depth 4\n' +
      '# TYPE request_duration_seconds summary\n' +
      'request_duration_seconds_count 2\n' +
      'request_duration_seconds_sum 0.6000000000000001\n'
  );
});
