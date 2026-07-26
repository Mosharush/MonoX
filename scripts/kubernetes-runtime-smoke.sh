#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
kind_command="${MONOX_KIND_COMMAND:-kind}"
cluster_name="${MONOX_KIND_CLUSTER_NAME:-monox-runtime-smoke}"
cluster_context="kind-${cluster_name}"
node_image="${MONOX_KIND_NODE_IMAGE:-kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f}"
application_image="monox-api:smoke"
namespace="monox-smoke"
deployment="monox-api-smoke"
smoke_port="${MONOX_SMOKE_PORT:-18080}"
temporary_directory="$(mktemp -d)"
manifest_file="${temporary_directory}/runtime-smoke.yaml"
port_forward_log="${temporary_directory}/port-forward.log"
port_forward_pid=""
cluster_created=false

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command is not installed: $1" >&2
    exit 69
  fi
}

cleanup() {
  local status="$1"
  trap - EXIT INT TERM
  set +e

  if [[ -n "${port_forward_pid}" ]]; then
    kill "${port_forward_pid}" >/dev/null 2>&1
    wait "${port_forward_pid}" >/dev/null 2>&1
  fi

  if [[ "${cluster_created}" == true ]]; then
    if ((status != 0)); then
      echo "Kubernetes runtime smoke failed. Collecting cluster diagnostics." >&2
      kubectl --context "${cluster_context}" --namespace "${namespace}" get all -o wide >&2
      kubectl --context "${cluster_context}" --namespace "${namespace}" describe pods >&2
      kubectl --context "${cluster_context}" --namespace "${namespace}" \
        logs "deployment/${deployment}" --all-containers --tail=200 >&2
      if [[ -s "${port_forward_log}" ]]; then
        cat "${port_forward_log}" >&2
      fi
    fi
    "${kind_command}" delete cluster --name "${cluster_name}" >/dev/null
  fi

  rm -rf "${temporary_directory}"
  exit "${status}"
}

assert_equal() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "${label}: expected '${expected}', got '${actual}'" >&2
    exit 1
  fi
}

trap 'cleanup "$?"' EXIT INT TERM

for command in curl docker kubectl node "${kind_command}"; do
  require_command "${command}"
done

if [[ ! "${cluster_name}" =~ ^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$ ]]; then
  echo "MONOX_KIND_CLUSTER_NAME must be a lowercase DNS label between 2 and 63 characters." >&2
  exit 64
fi
if [[ ! "${smoke_port}" =~ ^[0-9]+$ ]] || ((smoke_port < 1024 || smoke_port > 65535)); then
  echo "MONOX_SMOKE_PORT must be an unprivileged TCP port." >&2
  exit 64
fi
if "${kind_command}" get clusters 2>/dev/null | grep -Fqx "${cluster_name}"; then
  echo "Refusing to reuse or delete existing kind cluster '${cluster_name}'." >&2
  exit 73
fi

cd "${repository_root}"

docker build \
  --file infra/docker/Dockerfile.node \
  --build-arg MONOX_WORKSPACE=@monox/api \
  --tag "${application_image}" \
  .

"${kind_command}" create cluster --name "${cluster_name}" --image "${node_image}" --wait 180s
cluster_created=true
"${kind_command}" load docker-image "${application_image}" --name "${cluster_name}"

node packages/kube-renderer/src/cli.mjs render \
  infra/kubernetes/runtime-smoke.deployment.json \
  --output "${manifest_file}"

kubectl --context "${cluster_context}" apply --filename "${manifest_file}"
kubectl --context "${cluster_context}" --namespace "${namespace}" \
  rollout status "deployment/${deployment}" --timeout=180s
kubectl --context "${cluster_context}" --namespace "${namespace}" \
  wait --for=condition=Ready pod \
  --selector "app.kubernetes.io/name=${deployment}" \
  --timeout=60s

assert_equal "$(kubectl --context "${cluster_context}" --namespace "${namespace}" get \
  "deployment/${deployment}" -o jsonpath='{.spec.template.spec.containers[0].readinessProbe.httpGet.path}')" \
  "/readyz" "Readiness probe"
assert_equal "$(kubectl --context "${cluster_context}" --namespace "${namespace}" get \
  "deployment/${deployment}" -o jsonpath='{.spec.template.spec.containers[0].resources.requests.cpu}')" \
  "100m" "CPU request"
assert_equal "$(kubectl --context "${cluster_context}" --namespace "${namespace}" get \
  "deployment/${deployment}" -o jsonpath='{.spec.template.spec.containers[0].resources.limits.memory}')" \
  "512Mi" "Memory limit"
assert_equal "$(kubectl --context "${cluster_context}" --namespace "${namespace}" get \
  "deployment/${deployment}" -o jsonpath='{.spec.template.spec.containers[0].securityContext.runAsNonRoot}')" \
  "true" "Non-root container policy"
assert_equal "$(kubectl --context "${cluster_context}" --namespace "${namespace}" get \
  "deployment/${deployment}" -o jsonpath='{.spec.template.spec.automountServiceAccountToken}')" \
  "false" "Service account token policy"

kubectl --context "${cluster_context}" --namespace "${namespace}" get \
  "poddisruptionbudget/${deployment}" >/dev/null
kubectl --context "${cluster_context}" --namespace "${namespace}" get \
  "networkpolicy/${deployment}" >/dev/null

kubectl --context "${cluster_context}" --namespace "${namespace}" port-forward \
  --address 127.0.0.1 "service/${deployment}" "${smoke_port}:80" >"${port_forward_log}" 2>&1 &
port_forward_pid="$!"

for _ in $(seq 1 30); do
  if curl --fail --silent \
    "http://127.0.0.1:${smoke_port}/healthz" >"${temporary_directory}/health.json"; then
    break
  fi
  if ! kill -0 "${port_forward_pid}" >/dev/null 2>&1; then
    cat "${port_forward_log}" >&2
    exit 1
  fi
  sleep 2
done

if [[ ! -s "${temporary_directory}/health.json" ]]; then
  echo "Health endpoint did not become reachable through the Kubernetes Service." >&2
  exit 1
fi

curl --fail --silent --show-error \
  "http://127.0.0.1:${smoke_port}/readyz" >"${temporary_directory}/ready.json"
curl --fail --silent --show-error \
  "http://127.0.0.1:${smoke_port}/api/hello" >"${temporary_directory}/hello.json"

node --input-type=module - \
  "${temporary_directory}/health.json" \
  "${temporary_directory}/ready.json" \
  "${temporary_directory}/hello.json" <<'NODE'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [healthFile, readyFile, helloFile] = process.argv.slice(2);
const [health, ready, hello] = await Promise.all(
  [healthFile, readyFile, helloFile].map(async (file) => JSON.parse(await readFile(file, 'utf8')))
);

assert.deepEqual(health, {
  name: '@monox/api',
  version: '0.2.0-alpha.1',
  ready: true,
  live: true,
  state: 'running',
});
assert.deepEqual(ready, { ready: true });
assert.equal(hello.message, 'Hello from MonoX');
assert.equal(hello.environment, 'preview');
NODE

echo "Kubernetes runtime smoke passed for ${deployment} on ${node_image}."
