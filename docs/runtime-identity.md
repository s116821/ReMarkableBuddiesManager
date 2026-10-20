# Reported Buddy binary version

Read tablet state, then Read binary version in either the local browser/helper or
Electron app. The host invokes only the known `/opt/bin/reader-buddy --version`
using its maintained CLI. Current accepted Rust6254092 parses this option before
configuration, Store, provider or native runtime startup. This capability never
calls Vellum wrappers, installs packages, starts/stops a service or edits the tablet.

A successful result is **self-reported and unverified**. It tells you what that
known binary printed, not what a currently running process loaded or which trusted
package owns it. Running version, package ownership/source/signature/payload and
SDK/firmware compatibility remain unknown. Matching SemVer does not establish
package equivalence or make a release eligible; existing installation stays disabled.

Existing protected host setup, USB/interface/source route, peer-key-before-auth
and change watchers are reused. The current connection fingerprint is checked
before dial/auth; boot is checked before the command. Root-owned regular executable
and known `/opt`/`/opt/bin` directory metadata must be safe (no symlinks or group/world
write) and stable across the read. The fixed command accepts no caller path, command,
credential or environment values. Missing/unsafe/unsupported binaries refuse;
there is no fallback search or alternate executable.

One supported `reader-buddy`/`remarkable-reader-buddy` version line with a bounded
96-byte ASCII version token is accepted. Alongside release-shaped tokens, the pinned
build.rs produces dev.unknown or dev.<Git describe>: a semantic v-tag with optional
commit-count/g-hex suffix, or a7–40hex abbreviated/full commit, optionally dirty.
The captured clean pinned development output is dev.v0.2.0-73-g6254092; dev. is
not a generic permission for arbitrary text. These values remain self-reported. Output is512 bytes, discarded stderr4096
bytes and command4seconds. The private Python child is12seconds, host13seconds,
stdin4096 and host observation envelope8192bytes. Malformed/extra/control output
is not echoed; stale/cancelled/changed identity clears the displayed value and needs
fresh observation. Metadata comparison is not a binary hash/signature or a guarantee
against hostile root writers/power loss. Physical target and package proof remain
separate qualification gates.

```text
node --test tests/runtime-identity.test.mjs
python -m unittest discover -s tests/runtime_identity -v
npm run test:runtime-identity-hosts
npm run test:runtime-identity-hosts -- --packaged
```

Use supported Node/Python/host requirements and the documented headless wrapper.
Owned SSH tests use actual maintained Paramiko with synthetic version output and
known file/directory metadata. Child and shared UI tests use explicit synthetic
responses; native IPC invalid-input refusal is checked before substitution. These
prove the protocol/display guards, not an actual installed binary, running process,
USB cable or provenance. Screenshots retain their original build identity and show
synthetic data only. Central owning change: `manager-runtime-identity`.
