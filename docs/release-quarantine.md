# Manual Buddy release quarantine

Central owning change: `buddy-release-quarantine` in Docs. This optional Node
host command verifies and stages the current legacy release bytes. It has no
renderer/IPC, SSH, tablet or package-manager integration. Supported Node is the
same 24.21.x runtime as Manager; no additional package or credential is needed.

From this checkout, choose an existing local parent and a **new absolute** child
directory, and explicitly choose a stable published tag:

```text
node scripts/quarantine-buddy.mjs --tag vMAJOR.MINOR.PATCH --directory NEW_ABSOLUTE_DIRECTORY
```

Replace both placeholders; the tag must exist in the fixed
`s116821/ReMarkableBuddies` repository. No `latest`, source override, credential
option, arbitrary download URL or local SDK override is accepted. Fork users can
run the command without private tools; this command intentionally verifies only
the canonical publication. Paths with spaces must be quoted by your shell.
Use the actual canonical parent spelling, especially if Windows TEMP uses an
8.3 short-name alias. Resolve an existing parent with Node's built-in
`fs.realpathSync` before choosing the new child; the command does not silently
redirect an aliased or linked destination.

The command reads the public tag reference, its annotated tag object, and the
release for that tag. It requires one annotation pointing directly to a commit,
a stable published release, exactly both current architecture tarballs and
`provenance.json`, the publisher's completion record and matching GitHub asset
SHA256 digests. Lightweight tags, previews, absent legacy completion records and
future APK asset sets refuse. The observed tag can be moved remotely; this is a
before/after identity check, not a claim of GitHub immutability.

Asset downloads use derived GitHub API asset IDs. Requests omit credentials and
follow at most five HTTPS redirects only on api.github.com, github.com,
release-assets.githubusercontent.com or objects.githubusercontent.com. Metadata
is bounded at 256KiB, provenance at 64KiB, each tarball at 512MiB and total assets
at 768MiB. A five-minute operation deadline or Ctrl+C cancels work. Errors contain
fixed refusal codes rather than remote diagnostics or signed redirect URLs.

After metadata checks, a new directory is created exclusively, each original
asset is streamed to a fixed filename and hashed against its expected size and
digest, and downloaded provenance is compared with the tag/release identity.
The command rechecks publication identity and rehashes staged files before
publishing `quarantine-receipt.json`. Receipt writing uses an incomplete temporary
file and an exclusive atomic hard-link commit; the destination filesystem must
support hard links. A leftover `.quarantine-receipt.pending` is incomplete work,
never a completion receipt. A successful receipt states `legacy-quarantined`
and `apkInstallEligible: false`.

Cancellation and the monotonic deadline are checked again immediately after the
last asynchronous directory validation, with no await before issuing the atomic
hard link. Cancellation observed before that issuance refuses completion. Once
the link request is issued, it cannot be preempted: if it succeeds the command
reports committed success even when cancellation arrives in flight; if it fails
the command refuses. Cancellation after issuance does not revoke a receipt.

The tarballs stay opaque: no extraction, decompression, ELF inspection, execution,
service action, installation or key enrollment occurs. Checksum agreement with
canonical GitHub records is not an independent signature, compiler attestation,
SDK/firmware compatibility or payload-safety claim. Later use must reverify the
files; a saved receipt alone grants no authority.

Existing destinations, symlink parents, path aliases and overwrites refuse.
Failure can leave a new incomplete directory with partial public release bytes
and no successful receipt; inspect it and choose a new destination for retry.
The command never deletes user files. Directory/file identity checks detect
ordinary replacement but do not claim atomic safety against a malicious same-user
writer or stronger Windows file-identity guarantees. Use a local filesystem and
keep the staging directory idle during the command.

Verification is public and hardware-free:

```text
node --test tests/quarantine.test.mjs
```

Tests use actual local HTTP responses, gzip/tar bytes and filesystem writes, with
only fixed API transport translated to loopback. They establish consumer behavior
against supplied fixtures, not the existence or validity of a live official
release or signed APK production. Required CI also runs these tests on Windows.
