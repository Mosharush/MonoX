# `@monox/service-discovery`

Resolve logical service names to explicit internal or public URLs. There are no inferred company domains,
hardcoded ports, or ambient production fallbacks.

URLs with embedded usernames or passwords are rejected. Runtime credentials must be supplied through an
external secret reference, never encoded in a discovered endpoint.
