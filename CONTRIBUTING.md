# Contributing

MonoX welcomes focused changes that improve the generic platform without introducing product assumptions.

## Setup

```bash
corepack enable
yarn install --immutable
yarn doctor
yarn check
```

Create a branch, keep commits reviewable, and include tests. Pull requests should explain the contract being
changed, its security impact and the checks that passed.

## Design expectations

- Put runnable code in `apps`, reusable code in `packages`, and adapters in `infra`.
- Keep packages private unless the repository release policy explicitly selects one for publication.
- `create-monox` is the current release-reviewed package. Publish it only through the protected trusted
  publishing workflow, never from a developer machine.
- Do not commit real credentials or sanitized copies of production configuration.
- Keep configuration examples synthetic.
- Avoid new dependencies when a short, tested standard-library implementation is clear.
- Use current timestamps and truthful commit history.

Run `yarn format` only on files you intend to change, then run `yarn check` before opening a pull request.
