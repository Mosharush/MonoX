# Roadmap

## 0.1

- Clean workspace, runner and generator contracts
- Changed-workspace detection with internal dependent propagation
- Synthetic API and web examples
- Local Compose and Kubernetes workload templates
- Hardened CI and release design

## 0.2

- Align generated `monox.config.json` with the public schema and validate it in generated CI
- Task-level dependency graph, selective execution, cache, and cache explanations
- Safe local remote-proxy adapter with an explicit allowlist
- Preview environment lifecycle with TTL cleanup
- Provider-neutral deployment diff command

## 0.3

- Optional AWS and Google Cloud cluster adapters using OIDC
- Telemetry, queue and storage interfaces
- Versioned agent-kit compiler for multiple coding tools

The project will not add product-specific services to the core repository.
