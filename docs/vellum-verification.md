# Offline Vellum apk qualification

This opt-in developer harness exercises an actual separately built upstream tool.
It never invokes Vellum CLI, bootstrap, add, del or upgrade. It does not enable
installation in browser/Electron or establish real Buddy package/device eligibility.
Central owning change: `manager-vellum-verification` in ReMarkableBuddiesDocs.

## Source identity and licensing

Use Vellum apk branch source **ee31d275c7a2b7486e6de481ffe624b1de46d131**.
Its [successful public build run](https://github.com/vellum-dev/apk-tools/actions/runs/21912939175)
supports build attribution. The existing `v3.0.3` tag instead resolves to upstream
505bb9b0fb5d7d35a613a1f991e04a25eedadeeb, which lacks `--install-root` and was
rejected by this harness. The fork workflow builds branch HEAD and recreates the
release under its VERSION; tag identity cannot establish artifact source here.
Workflow chronology is not cryptographic ARM artifact attestation. Host source-build
results do not qualify published ARM bytes or any tablet.

Upstream apk source is GPL-2.0-only; keep its checkout and binary outside Manager.
This repository contains orchestration/assertions, not copied upstream implementation
or a bundled apk binary. Preserve upstream notices and matching source obligations
if binaries are redistributed later. Vellum CLI MIT source is reference only:
v0.3.2 initializes/repairs virtual packages before parsing even observation commands.
Do not use that wrapper for read-only qualification.

## Build and record

Use Git, Python 3.12+, Docker Linux containers, and a task-owned Linux image containing
Python, OpenSSL, gcc, Meson/Ninja, OpenSSL development headers and zlib development
headers. No host/global installation is performed by the harness. Build dependencies
may be supplied in a separate developer container; record its immutable image ID and
dependency versions. Do not alter shared image tags. A standard manual build is:

```text
git clone https://github.com/vellum-dev/apk-tools.git UPSTREAM
git -C UPSTREAM fetch origin ee31d275c7a2b7486e6de481ffe624b1de46d131
git -C UPSTREAM -c core.autocrlf=false archive --format=tar --output=ABSOLUTE_ARCHIVE ee31d275c7a2b7486e6de481ffe624b1de46d131
```

Extract that archive inside temporary Linux build storage, preserving bytes and
executable modes. Do not build a Windows CRLF checkout or patch source. Run:

```text
VERSION=3.0.3 meson setup BUILD SOURCE -Ddocs=disabled -Dhelp=disabled -Dlua=disabled -Dpython=disabled -Dtests=disabled -Dzstd=disabled -Ddefault_library=static
ninja -C BUILD src/apk
```

`3.0.3` is upstream tool VERSION, not a Buddy/Manager project version. Save build
logs and binary outside the repository. Prepare a local build-details JSON containing
`runtime_image_id` (`sha256:` plus full Docker image ID), `base_image_id`,
`build_options`, `dependencies`, `build_log_sha256` and recipe digest. Then:

```text
python tests/vellum/record_build.py --source UPSTREAM --archive ARCHIVE --apk BINARY --build-details DETAILS --output NEW_BUILD_RECEIPT
python tests/vellum/qualify.py --apk BINARY --build-receipt BUILD_RECEIPT --source-archive ARCHIVE --output test-results/NEW_QUALIFICATION.json
python -m unittest discover -s tests/vellum -p "test_*.py" -v
```

The recorder validates all 417 Git blob identities, executable/link modes and exact
inventory against the pinned commit. The harness validates binary/archive digests,
source pin and image ID against the local receipt. The receipt is developer-supplied
evidence, not a signed official provenance or a guarantee of the compiler's behavior.
Outputs must be new; prior evidence is preserved. CI does not silently run or claim
this opt-in actual-tool harness when the tool/image is unavailable.

## Observed contract and limits

Two containers separate fixture generation from observation. Private signing keys
exist only in generation tmpfs and are removed before it exits; host temporary
fixtures contain public keys only and are removed on completion.
On native Linux, both containers use the invoking process's effective UID/GID so
the private mode-0700 fixture directory remains accessible with all capabilities
dropped. This identity is derived by the runner, never supplied by a caller. Windows
Docker Desktop keeps its existing mount ownership behavior. Tool and harness files
must be readable/executable by that identity; no permissions are widened by the runner.
Observation mounts
fixtures and tool read-only, disables networking, drops capabilities and inherits
neither host APK_CONFIG nor system trusted keys. It explicitly uses isolated metadata
and payload roots. Inventories include files, directories, modes and symlink targets;
escaping links refuse. Commands/containers have time bounds and timeout cleanup.

Upstream mkpkg/mkndx generate uncompressed signed APKv3 synthetic package/index
fixtures. Valid bytes succeed with their explicit fixture key. Missing/wrong keys,
changed signed package/index control and changed package payload must fail with the pinned tool's recognized
trust/signature/integrity classification; crash, timeout or generic usage failure
cannot count as cryptographic refusal. Diagnostics are bounded and represented by
digests/classifications; private keys and script body output are not exported.

Actual apk version retains `1.2.3-r2 > 1.2.3-r1`. A deliberately seeded installed
database and scripts archive provide full version/architecture/source-commit/origin,
dependencies, script type names and installed/broken-script status. File owner lookup
includes full pkgrel; unowned lookup refuses. The synthetic script sentinel must never
execute. Query `origin` means source package, not historical distribution source;
available repositories do not prove installed origin. Seeded state is not an install,
service-health or provenance proof. APKv2, solver/install lifecycle, recovery and
source switching remain unqualified.

Real delivery still needs official signed per-target Buddy APKs, authenticated
tag/source/consumed-SDK provenance and vetted trust keys, qualified model/firmware
constraints, wired device identity, one actual package owner, data-preserving lifecycle
and rollback. Equal SemVer or successful synthetic signature checks cannot establish
package equivalence or authorize downgrade/handoff. Existing REM-46 production tooling
and its unresolved gates are unchanged.
