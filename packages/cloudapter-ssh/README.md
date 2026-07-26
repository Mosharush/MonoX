# `@monox/cloudapter-ssh`

Defines a transport plan for an existing SSH server. `target.serverRef`, `target.bindings.identityRef` and a
`target.bindings.secretStoreRef` containing pinned known-hosts data are mandatory. Connection details and
credentials are resolved only by the injected transport. Private key material, unverified hosts and
shell-string commands are rejected. The caller injects SSH through `context.ssh.execute(action, connection)`.
