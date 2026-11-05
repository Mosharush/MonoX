# Project configuration schema

`schemas/v2/monox.schema.json` is the public structural contract for `monox.config.json`. Repository
validation uses that document. `create-monox` bundles the same bytes at
`packages/create-monox/schema/v2/monox.schema.json` and writes them into every generated project. Generation
fails before creating a destination when the generated document does not match the bundled schema.

`schemas/monox.schema.json` is the editor entry point. It accepts each published version through `oneOf`.
`@monox/config` keeps the additional reference, secret and target-conflict checks that JSON Schema does not
express. Those checks do not replace the public schema.

Generated Yarn, npm and pnpm workflows run `node scripts/verify-monox-config.mjs`. The script hashes
`schemas/v2/monox.schema.json` against the integrity recorded at generation, then validates
`monox.config.json`. Either a schema-byte change or a document that violates the schema exits non-zero.

## Product-specific configuration

Do not add product fields to the core schema. `additionalProperties` is false on the root object,
environments, targets and add-ons. Workload behavior belongs in the workspace `package.json.deployment` block.
Add-on settings belong in that add-on's `config` string map and `secretRefs`. Workload profiles remain open
objects because they carry deployment patches, not a product namespace.

## Changing the current public schema

`schemas/v2/monox.schema.json` may gain compatible optional properties or wider enums while `schemaVersion`
stays `"2"`. A published version file is otherwise immutable: do not rename or remove properties, tighten
patterns, or change the meaning of an existing value.

For a compatible v2 change:

1. Edit `schemas/v2/monox.schema.json`.
2. Copy those exact bytes to `packages/create-monox/schema/v2/monox.schema.json`. Repository validation fails
   while the copies differ.
3. Update `schemas/fixtures/v2/valid.config.json` and `schemas/fixtures/v2/invalid-cases.json` when the new
   shape needs coverage.
4. Extend the dependency-free validator in `packages/create-monox/src/json-schema.mjs` before using a new JSON
   Schema keyword. Unknown keywords fail validation, so generation and generated CI stay closed until the
   validator understands the keyword.
5. Update `@monox/config` when the new value needs a reference, security or conflict check, and regenerate
   `packages/config/src/generated.d.ts` with `node packages/deploy-schema/scripts/generate-types.mjs --write`.
6. Regenerate a sample project and confirm `node scripts/verify-monox-config.mjs` passes. Existing generated
   projects keep the schema bytes they were given until someone regenerates them or edits those files.

## Adding the next schema version

A breaking change adds `schemas/v3/monox.schema.json` and leaves v2 untouched. Extend the `oneOf` array in
`schemas/monox.schema.json`. Point `create-monox` at the version it writes, bundle that file, and set
`schemaVersion` to the new const. Generated projects do not upgrade in place. Adopting the new version means
replacing `schemas/vN/monox.schema.json`, updating `schemaVersion` and the fields that version requires, and
re-running `node scripts/verify-monox-config.mjs`. A hand-edited schema whose bytes no longer match the
generated integrity fails CI even when the document still validates against the replacement schema.

The validator resolves only internal JSON pointers. Editor entry points that reference version files with
relative `$ref` values stay outside the generated check. Validate a concrete version document instead.
