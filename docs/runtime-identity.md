# Reported Buddy binary version

In the browser or Electron app, read the tablet state, then select **Read binary version**.
Manager asks the selected Buddy executable for its version over USB. The command works
with Buddy stopped and completes before provider or notebook startup.

For a loaded service, Manager reads its direct executable path. It recognizes
`/home/root/.local/lib/remarkable-buddies/reader-buddy` for resident installations
and `/opt/bin/reader-buddy` for standalone installations. If the service is absent
and its launcher record is empty, Manager checks the standalone path.

Manager verifies the same tablet, protected parent directories, executable metadata
and service selection across the read. It passes only `--version` to the selected
executable. If that file is missing, unsafe or changes during the read, the version
is unavailable.

**Binary version** is the executable's self-report. The version of a running process,
package ownership, signature and update eligibility require separate verification.

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
