# Manual Manager bundle verification

Central owning change: `manager-bundle-verification` in Docs. This source-checkout
command stages original published browser/Windows/Linux ZIPs and verifies bounded
embedded build declarations. It does not activate an update or install software.
The running Angular/Electron release-discovery view is unchanged.

Use supported Node24.21 and a trusted local Python **3.12** installation. Select
the interpreter's absolute path explicitly; no runtime is installed for you.
Choose an existing canonical local parent and a new absolute child directory on
a hard-link-capable filesystem. Resolve Windows short-name/case aliases first.
From this Manager checkout:

```text
node scripts/quarantine-manager.mjs --tag vMAJOR.MINOR.PATCH --directory NEW_ABSOLUTE_DIRECTORY --python TRUSTED_ABSOLUTE_PYTHON312
```

Replace all placeholders and quote paths with spaces. The selected stable tag
must exist at the fixed canonical `s116821/ReMarkableBuddiesManager` repository.
The command requires an annotated tag pointing directly to a commit, a published
stable release, exactly `manager-browser.zip`, `manager-win32-x64.zip`,
`manager-linux-x64.zip`, `provenance.json`, and the actual publisher's single
`manager-complete` record. Manifest/completion/GitHub digests and all downloaded
bytes must agree. It does not accept caller download URLs, repositories, filenames,
preview tags or a fallback to Buddy's source. Project versions come from tags.

The shared downloader retains the [Buddy quarantine limits and safe retry
rules](release-quarantine.md): credential-free fixed GitHub APIs and restricted
redirects, bounded JSON/bytes, new exclusive staging, publication recheck, staged
rehash and an atomic completion receipt. Existing destinations/aliases/links
refuse. Failed or cancelled work can leave partial public-byte staging without a
successful receipt; choose a new directory for retry. No user file is deleted.

A fixed trusted checkout verifier runs with isolated Python `-I -S -B`, an
allowlisted environment, 30-second process limit, 8KiB combined output limit and
shared cancellation. Its output is a fixed sanitized result. The interpreter is
part of the trusted host setup; selecting an arbitrary program cannot establish
trust. The standalone Python helper does not authenticate a release on its own.

Before Python's standard ZIP parser opens an archive, the verifier checks the
bounded final EOCD and central-directory size/count. Current format excludes
ZIP64, archive comments and multidisk files; at most4096 entries/2MiB directory,
2GiB declared expanded bytes per ZIP, safe unique regular paths, no encryption,
extra metadata or unsupported compression. Only root `build-info.json` is read
as a decompressed member, at most16KiB and64KiB compressed. Its exact tag/source/
version/official declaration must match the selected release. App files stay
compressed and are never extracted, started or individually safety-qualified.

The current producer's unchanged pure identity validator is reused from
`host/qualified-producer/artifacts.py`, copied byte-for-byte from
[Manager99bde579 release/artifacts.py](https://github.com/s116821/ReMarkableBuddiesManager/blob/99bde579c7ca458cd9670cc83682e0ed93c58c48/release/artifacts.py).
Its SHA256 is `4c0386ae79b1de55f84bea1cb349e62620ef2a763d90c0366a939aec37cdc94c`.
The bounded verifier checks this trusted resource before loading it and calls
only its Release/verify_identity contract with the fixed three package names.
The deleted policy/coordinator publisher modules are not runtime dependencies.
The producer's unbounded package rereader and build/publish functions are not
called. Changed or missing qualified bytes refuse before loading; there is no
best-effort fallback. Packages carry the same fixed identity resource under host/.

The fixture-only current-manager-build.py is the exact99bde579 build source,
SHA256 `5fc651228ef50c5231b71ff91a2c688aade622c2a7a7c685cfbde08a8d660670`.
It generates small actual ZIPs with synthetic payload using the current archive
function. It is not packaged runtime code or evidence of a full application build,
live official release, payload safety or installation eligibility.

Success publishes `quarantine-receipt.json` with `embeddedIdentityVerified: true`
and `updateEligible: false`. Checksums and embedded declarations do not attest
compiler truth, native compatibility, executable safety or an independent artifact
signature. Later use requires fresh verification and a separately qualified update
path. Cancellation/deadline is checked after final awaited validation immediately
before atomic link issuance; an already-issued successful link remains committed
even if cancellation arrives in flight. Same-user malicious writers are outside
the directory/file bracket guarantee.

Python's Windows path and descriptor metadata can differ. The verifier brackets
each API against itself, requires regular-file/type/size agreement and actual
byte hashes, and makes no Windows stable-file-ID or atomic-writer guarantee.
Linux retains its direct path/handle identity check as well.

Public hardware-free checks:

```text
node --test tests/manager-bundles.test.mjs tests/quarantine.test.mjs
```

Tests use actual local HTTP, Python-generated ZIPs and filesystem/process I/O,
with synthetic payload and controlled canonical API transport. They do not prove
a live official release, full compiled payload or physical/native installation.
Required hosted checks include supported Node/Python on Linux and Windows.
