#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
kind_command="${MONOX_KIND_COMMAND:-kind}"
cluster_name="${MONOX_GENERATED_KIND_CLUSTER_NAME:-monox-generated-smoke}"
cluster_context="kind-${cluster_name}"
node_image="${MONOX_KIND_NODE_IMAGE:-kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f}"
project_name="generated-runtime"
target_id="kubernetes-existing-kubernetes"
namespace="${project_name}"
api_deployment="api"
web_deployment="web"
temporary_directory="$(mktemp -d)"
project_directory="${temporary_directory}/${project_name}"
render_directory="${temporary_directory}/rendered"
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

  if [[ "${cluster_created}" == true ]]; then
    if ((status != 0)); then
      echo "Generated project runtime smoke failed. Collecting cluster diagnostics." >&2
      kubectl --context "${cluster_context}" --namespace "${namespace}" get all -o wide >&2
      kubectl --context "${cluster_context}" --namespace "${namespace}" describe pods >&2
      kubectl --context "${cluster_context}" --namespace "${namespace}" \
        logs "deployment/${api_deployment}" --tail=200 >&2
      kubectl --context "${cluster_context}" --namespace "${namespace}" \
        logs "deployment/${web_deployment}" --tail=200 >&2
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

wait_for_http() {
  local source_deployment="$1"
  local url="$2"
  local expected="$3"

  for _ in $(seq 1 30); do
    if kubectl --context "${cluster_context}" --namespace "${namespace}" \
      exec "deployment/${source_deployment}" -- \
      node --input-type=module -e \
      'const [url, expected] = process.argv.slice(1); const response = await fetch(url); if (!response.ok) process.exit(1); const body = await response.text(); if (!body.includes(expected)) process.exit(1);' \
      "${url}" "${expected}"; then
      return 0
    fi
    sleep 2
  done

  echo "${source_deployment} could not reach ${url} with the expected response." >&2
  return 1
}

manifest_image() {
  local manifest="$1"
  node --input-type=module - "${manifest}" <<'NODE'
import { readFile } from 'node:fs/promises';

const manifest = process.argv[2];
const imagePrefix = 'image: "';
const images = (await readFile(manifest, 'utf8'))
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith(imagePrefix) && line.endsWith('"'))
  .map((line) => line.slice(imagePrefix.length, -1));

if (images.length !== 1) {
  throw new Error(`${manifest} must contain exactly one rendered workload image; found ${images.length}.`);
}
process.stdout.write(images[0]);
NODE
}

trap 'cleanup "$?"' EXIT INT TERM

for command in docker kubectl node npx "${kind_command}"; do
  require_command "${command}"
done

if [[ ! "${cluster_name}" =~ ^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$ ]]; then
  echo "MONOX_GENERATED_KIND_CLUSTER_NAME must be a lowercase DNS label between 2 and 63 characters." >&2
  exit 64
fi
if "${kind_command}" get clusters 2>/dev/null | grep -Fqx "${cluster_name}"; then
  echo "Refusing to reuse or delete existing kind cluster '${cluster_name}'." >&2
  exit 73
fi

cd "${repository_root}"

node packages/create-monox/src/cli.mjs "${project_name}" \
  --directory "${project_directory}" \
  --package-manager yarn \
  --infra all \
  --delivery kubernetes:existing-kubernetes \
  --yes \
  --no-git

node --input-type=module - \
  "${project_directory}/monox.config.json" \
  "${target_id}" \
  "${cluster_context}" \
  "${namespace}" <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';

const [file, targetId, clusterRef, namespace] = process.argv.slice(2);
const config = JSON.parse(await readFile(file, 'utf8'));
const target = config.targets?.[targetId];
if (!target) throw new Error(`Generated target is missing: ${targetId}.`);
target.clusterRef = clusterRef;
target.bindings = { ...target.bindings, namespace, registry: 'docker.io/library' };
await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
NODE

node packages/cli/src/cli.mjs render \
  --root "${project_directory}" \
  --env development \
  --target "${target_id}" \
  --all \
  --output-dir "${render_directory}" \
  --json >"${temporary_directory}/render-result.json"

api_image="$(manifest_image "${render_directory}/${api_deployment}.kubernetes.yaml")"
web_image="$(manifest_image "${render_directory}/${web_deployment}.kubernetes.yaml")"

docker build \
  --file "${project_directory}/infra/docker/api.Dockerfile" \
  --tag "${api_image}" \
  "${project_directory}"
docker build \
  --file "${project_directory}/infra/docker/web.Dockerfile" \
  --tag "${web_image}" \
  "${project_directory}"

"${kind_command}" create cluster --name "${cluster_name}" --image "${node_image}" --wait 180s
cluster_created=true
"${kind_command}" load docker-image "${api_image}" "${web_image}" --name "${cluster_name}"

kubectl --context "${cluster_context}" apply --filename "${render_directory}"
kubectl --context "${cluster_context}" --namespace "${namespace}" \
  rollout status "deployment/${api_deployment}" --timeout=180s
kubectl --context "${cluster_context}" --namespace "${namespace}" \
  rollout status "deployment/${web_deployment}" --timeout=180s

for deployment in "${api_deployment}" "${web_deployment}"; do
  assert_equal "$(kubectl --context "${cluster_context}" --namespace "${namespace}" \
    get "deployment/${deployment}" \
    -o jsonpath='{.spec.template.spec.securityContext.runAsUser}')" \
    "10001" "${deployment} pod UID"
  assert_equal "$(kubectl --context "${cluster_context}" --namespace "${namespace}" \
    exec "deployment/${deployment}" -- \
    node -e 'process.stdout.write(String(process.getuid()))')" \
    "10001" "${deployment} runtime UID"
done

wait_for_http "${web_deployment}" "http://${api_deployment}:3001/health" '"status":"ok"'
wait_for_http "${api_deployment}" "http://${web_deployment}:4173/" '<title>MonoX app</title>'

echo "Generated project runtime smoke passed for ${project_name} on ${node_image}."
