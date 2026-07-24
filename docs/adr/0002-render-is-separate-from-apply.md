# ADR 0002: Keep render separate from apply

- Status: Accepted
- Date: 2026-07-24

## Context

Rendering deployment artifacts is deterministic and can run without cluster credentials. Applying those
artifacts changes external state and depends on an environment, identity, threat model, and approval policy.
Combining both operations would make a safe inspection command capable of changing infrastructure.

## Decision

Core MonoX commands validate and render artifacts but do not apply them to a long-lived cluster. Apply belongs
to a deployment adapter with explicit environment selection, reviewed identity, and human approval.

The CI runtime smoke is a narrow exception for a synthetic fixture. It creates, owns, and deletes an ephemeral
kind cluster inside the job. It has no production credentials and cannot select an external cluster context.

## Consequences

- Pull requests can render and review artifacts without deployment authority.
- Production state changes remain visible and protectable as a separate operation.
- Provider adapters must define identity, diff, approval, rollback, and cleanup behavior before they are
  added.
- Runtime confidence requires explicit smoke or integration workflows in addition to renderer unit tests.
