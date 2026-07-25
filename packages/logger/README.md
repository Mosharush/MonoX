# `@monox/logger`

Dependency-free structured logging for MonoX runtimes. Context is immutable, common credential fields are
redacted recursively, and the default sink emits one JSON document per line.

The default classifier handles camelCase, kebab-case and snake_case keys, preserves explicit references and
does not treat words such as `tokenizer` or token-usage counters as credentials. Known credential value
formats are redacted even when their containing key is neutral.
