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

## Published ARM assets under explicit emulation

Central owning change: `manager-published-arm-apk`. This separate opt-in mode tests
unchanged published bytes with the same 13 fixtures; it does not reinterpret them
as a local source build. The original mode still requires all 417 verified source
entries. No asset or emulator is bundled, downloaded or installed by the runner.

The pinned mutable upstream v3.0.3 release is ID 285324426. ARMv7 asset ID 354274748
has SHA-256 `2fa969001cd8fbc8fa373b7c3dfcc99f858ceb516306d35d1b037c09861ac94a`;
AArch64 asset ID 354274751 has SHA-256
`dab5b2b615cae41fd90a99fc6bdca87d26d04c0755440bded6b4832547c09cf7`.
Download explicitly from the public release and independently hash the bytes.
The successful source workflow supports attribution to the branch commit above,
not signed publisher/source attestation; the upstream tag differs. The runner's
pins identify the tested bytes, not an accepted production signing-key policy.

Supply a separately obtained regular static QEMU 8.2.2 executable. Supported
emulator SHA-256 values are `a971ead7b78ecb0c10c47be9f8bb7402c0be1fc0bca958c1deed72c56aa417bb`
for qemu-arm and `4b7300c73beff4d34ce396db5b0db516e5590ece7215ac9c1e85e5f203781190`
for qemu-aarch64. These were observed at `/usr/local/bin/qemu-arm` in existing image
`sha256:ad36c99fa4d211ae7a2d9b1e02d13b41d9616f61bd355315bd5e72315a38e6bb` and
`/usr/local/bin/qemu-aarch64` in existing image
`sha256:081cfe92ac8a928ce698b25bf65d8e51a37f6eaa85bb44cedf9bb84db5c078da`.
Use actual dereferenced files, not the images' symlink aliases. Public users may
obtain matching runtime/image bytes through their own recorded developer setup;
absence of these exact tools means this mode is unavailable, not a test pass.
No global binfmt registration or privileged container is required.

Prepare a new local JSON receipt, using actual values for one architecture:

```json
{
  "evidence_class": "published-asset-emulated",
  "repository": "vellum-dev/apk-tools",
  "release_id": 285324426,
  "release_tag": "v3.0.3",
  "release_immutable": false,
  "architecture": "armv7",
  "asset_id": 354274748,
  "asset_name": "apk-armv7",
  "github_digest": "sha256:2fa969001cd8fbc8fa373b7c3dfcc99f858ceb516306d35d1b037c09861ac94a",
  "binary_sha256": "2fa969001cd8fbc8fa373b7c3dfcc99f858ceb516306d35d1b037c09861ac94a",
  "emulator_sha256": "a971ead7b78ecb0c10c47be9f8bb7402c0be1fc0bca958c1deed72c56aa417bb",
  "emulator_version": "8.2.2",
  "attributed_workflow_run": 21912939175,
  "attributed_source_revision": "ee31d275c7a2b7486e6de481ffe624b1de46d131",
  "runtime_image_id": "sha256:YOUR_ACTUAL_64_HEX_IMAGE_ID"
}
```

The runtime image needs Python3.12+ and OpenSSL. The qualified source-build fixture
image can be reused with both external static executables mounted read-only. This
developer-supplied receipt records unsigned attribution; it does not authenticate
a publisher/compiler. Do not add source-build fields or a fabricated 417-entry count.
For AArch64 change architecture, asset ID/name and both digests to the values above.

```text
python tests/vellum/qualify.py --apk ARM_ASSET --published-asset-receipt ASSET_RECEIPT --emulator STATIC_QEMU --output test-results/NEW_ARM_QUALIFICATION.json
```

This mode forbids `--source-archive`; source-build mode forbids `--emulator`.
The runner and container verify tool/emulator bytes and invoke only fixed paths.
Both phases retain Linux effective-owner binding and all existing isolation flags.
The output distinguishes emulated published assets and records safe identities.
Synthetic x86_64 installed metadata tests parser behavior, not ARM compatibility.
No native CPU/kernel/firmware, SSH shell, real package trust or installation result
follows. No Docker/QEMU dependency is added to the Manager product or renderer.
Any later asset/emulator redistribution needs matching license/notices/source review;
exact static-linked upstream dependency license inventory remains unestablished here.

## Shared fixture contract and limits

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

## Original public test-package observer

`tests/vellum/real_fixture.py` is a separate opt-in Linux nonroot observer for
original two-target public test packages. Its default still accepts the historical
six-file `legacy-no-sdk` handoff with an adjacent `hash-manifest.json`, a 32 MiB
limit per APK and the ordinary three-file payload. It requires a separately
communicated manifest digest and the actual public key's DER-SPKI digest.

The explicit `--manifest EXTERNAL_MANIFEST` option selects only schema 2,
`current-resident-fixture`. Keep this regular, canonical, ancestor-safe file outside
the unchanged original directory. That directory must contain exactly the two
versioned APKs, `buddy-index.adb`, `fixture.pub` and
`test-key-build-receipt.json`. The manifest is limited to 16 KiB, the receipt to
64 KiB and each APK to 64 MiB (128 MiB total). There is no arbitrary size override.

The external manifest has exactly `schema`, `purpose`, `profile`, `eligibility`,
`installation_eligible`, `private_key_included`, `source`, `helper_commit`,
`docs_commit`, `license`, `builds` and `artifacts`. Purpose remains
`host-only-offline-consumer-test-fixture`, eligibility is `not-qualified`, and both
authority flags are false. Source records repository, Git SHA, tag and epoch;
`builds` holds exactly the ARMv7 and AArch64 declared build objects. Each artifact
record pins bytes and SHA256, including the completed receipt. Supply its SHA256
and the public DER-SPKI pin independently; adjacent files cannot establish trust.
Commit IDs and build/toolchain fields are developer attribution, not compiler
attestation. Versions come from Git tags rather than a maintained source version.

The current fixture permits exactly the ten reviewed ARMv7 resident paths:

```text
home/root/.local/lib/remarkable-buddies/Dobby-LICENSE
home/root/.local/lib/remarkable-buddies/OpenSDK-LICENSE
home/root/.local/lib/remarkable-buddies/libremarkable-resident.so
home/root/.local/lib/remarkable-buddies/reader-buddy
home/root/.local/lib/remarkable-buddies/resident-profile.json
home/root/.local/lib/remarkable-buddies/resident-recovery.json
usr/lib/systemd/system/reader-buddy-stock-recovery.service
usr/lib/systemd/system/reader-buddy.service
usr/share/remarkable-buddies/LICENSE
usr/share/remarkable-buddies/build.json
```

The executable is 0755 and all other files, including the shared library, are
0644, with root/root ownership and the exact source epoch. Signed metadata must
match the finite `rm2-resident-test-key` profile, device `rm2`, firmware
`3.28.0.172`, dependencies `remarkable-os=3.28.0.172-r0` and `rm2`, SDK source
`a0c6480be6785480c2e0da76a3c06697a18efae4` and bundle SHA256
`f9c4b44b9baf281bc47c74470ddd8d098853e79383e9323e5ff02ef2846fb477`.
AArch64 remains SDK-bound `unqualified-development` with only
`usr/bin/reader-buddy` and the shared LICENSE/build.json paths. Unknown paths,
scripts, triggers, links, metadata or numeric type aliases refuse. These fixture
restrictions do not enable the resident profile or qualify any tablet model.

Canonical declared build bytes use sorted-key, compact, ASCII JSON plus one
newline. Their size/SHA256 must match the signed build.json entry. The observer
does not extract that file. Source, target/ABI, SDK, feature, binary and payload
records must agree across manifest, receipt, signed metadata and authenticated
index. Saved producer index comparison remains distinct from independent index
regeneration, and metadata identity remains distinct from complete APK SHA256.

For a deliberately selected actual observation, provide existing qualified
source-build tool inputs and a new output path under an existing directory:

```text
python3 tests/vellum/real_fixture.py --inputs ORIGINALS --manifest EXTERNAL_MANIFEST --manifest-sha256 INDEPENDENT_MANIFEST_SHA256 --expected-spki INDEPENDENT_DER_SPKI_SHA256 --apk APK_TOOL --build-receipt TOOL_BUILD_RECEIPT --source-archive TOOL_SOURCE_ARCHIVE --output NEW_RESULT_JSON
```

The runner validates the existing 417-entry tool-source contract and immutable
runtime image. It binds the external manifest at the fixed read-only
`/handoff/manifest.json` and checks its digest before/after each APK command and
at completion. Existing nonroot, no-network, read-only mounts, snapshots, bounded
output/timeouts and owned cleanup remain in force. No signing, package generation,
payload extraction/execution, package database mutation or device access occurs.

Plan temporary storage for three bounded ARMv7 altered copies (control,
executable and shared library), a small altered index and public-only metadata.
Both ELF mutations require a unique complete-file size/hash match within a bounded
candidate scan; a raw unique-ELF assumption is insufficient for this layout.
Wrong/missing keys and altered control/index/both payloads must produce recognized
signature/integrity refusals. A completed current run records 14 observations;
legacy retains its 12. Crash, timeout or usage errors are failures.

Run the default pure checks with
`python3 -B -m unittest discover -s tests/vellum -p 'test_*.py' -v`.
They use tiny synthetic metadata/files/ELFs and owned subprocess guards; they do
not execute Docker or the APK tool. Source-test success does not establish actual
cryptographic verification. Actual current-fixture observation remains a separate
unqualified operation until its own result is recorded; installation and update
eligibility remain false in every report.
