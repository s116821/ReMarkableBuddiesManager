# Original signed Buddy test-fixture observation

Central change: `manager-signed-fixture-verification` in ReMarkableBuddiesDocs.
This opt-in **Linux developer** harness verifies original historical Buddy APKs and
index with a public key only. It is separate from Manager's ZIP consumer and the
synthetic Vellum harness. It adds no browser/Electron integration, update offer,
package installation, production trust enrollment or tablet operation.

Use Python3.12+, Docker Linux containers, and the already qualified
[exact-source apk build](vellum-verification.md). Supply the external apk binary,
source archive and developer build receipt; none is downloaded/bundled by this
runner. The receipt's immutable local runtime image must contain Python and OpenSSL.
Run as a nonroot Linux user already permitted to use Docker. No permissions,
shared image tags or host packages are changed. Actual tool qualification remains
separate from developer receipt trust and upstream artifact attribution.

Obtain Main's original six public files through an explicitly authorized transfer.
The transport ZIP is not a Manager ZIP-admission artifact. Before any unwrap,
verify its separately supplied byte size/SHA256, then allow exactly the six named
regular entries and verify their bounded sizes/hashes. Do not extract APK payloads.
Keep the six files in their own directory: two original target APKs, `buddy-index.adb`,
`fixture.pub`, `test-key-build-receipt.json`, `hash-manifest.json`. No private signer
is requested. Independently obtain the manifest SHA256 and generation-control
**DER SubjectPublicKeyInfo SHA256**; adjacency to the key is not trust authority.

```text
python tests/vellum/real_fixture.py --inputs ORIGINAL_SIX_FILE_DIRECTORY --manifest-sha256 INDEPENDENT_MANIFEST_SHA256 --expected-spki INDEPENDENT_GENERATION_SPKI_SHA256 --apk EXACT_APK_BINARY --build-receipt BUILD_RECEIPT --source-archive SOURCE_ARCHIVE --output NEW_REPORT_JSON
python -m unittest discover -s tests/vellum -p test_real_fixture.py -v
```

The output parent must already exist, be a regular path and the output must be new.
The narrow input contract is the original two-target `legacy-no-sdk`, packaging
revision0, `not-qualified` fixture. Tag/full apk version/source are read from the
independently pinned handoff; no project version is minted or maintained in code.
Unknown SDK/profile contracts and other artifact layouts require separate review.

Admission validates the manifest pin, original sizes/digests, exact inventory and
reported public-only producer correspondence. Observation recomputes the actual
PEM-to-DER SPKI, then verifies both APKs and the index with the pinned upstream tool.
Only `verify` and bounded `adbdump --format json` applets run. Explicit metadata,
payload, keys, empty config/repositories and no-network/cache/log flags prevent host
trust fallback. No Vellum wrapper, signing/index generation, extraction or payload
execution is used. Docker uses effective UID/GID, network none, read-only root and
mounts, no capabilities, no-new-privileges,256MiB memory/32 processes and16MiB
noexec tmpfs. Actual read-only mounts/nonroot identity are observed in-container.
Original/isolated content, inventory and modes are checked per read and finally.
Symlinks/special files refuse. A byte-for-byte source archive and binary check
revalidates the417-entry build receipt; that is reuse of prior recorded source
qualification, not a new independent417-blob audit or compiler attestation.

Each child read has15seconds and64KiB combined output; Docker has120seconds and
128KiB output. Streaming capture enforces bounds while running. A timeout/output
failure removes only the generated owned container and kills its CLI process group;
cleanup failure is a failure. Raw diagnostics stay out of the exported report.

Focused negative copies alter signed package/index description and one actual ELF
payload byte. A different public RSA modulus supplies the wrong-key set without
creating a private key or keypair. The wrong independent SPKI is checked against
actual DER. Verification refusals require exit1 plus recognized trust/signature/
integrity status and empty stderr. Crashes/timeouts/usage cannot pass a negative case.
Originals remain unchanged; no broad synthetic matrix or producer rebuild runs.

The report compares standard fields/full pkgrel/vendor tags and the exact three-file
signed inventory (modes/time/size/digest) with original receipt claims and both
signed index entries. `apk verify` checks actual payload integrity; metadata
inspection does not extract or parse embedded `build.json` contents or execute
its binary. Signed file claims do not establish compiler/source/SDK truth.
Index `hashes` is package metadata SHA256, separately recorded from complete APK
SHA256. This public-only consumer compares it with **saved producer regeneration**
readback; it does not regenerate/recompute the index metadata identity independently.
The disposed signer is not regenerated. Independent public-only index binding and
signature-valid malformed cases remain unqualified.

Every successful result retains `installation_eligible=false`, `update_eligible=false`
and `eligibility=not-qualified`. Historical source/compiler, production signer,
SDK, model/firmware, lifecycle/rollback/source switching/reproducibility and native
qualification remain separate gates. Normal CI runs only the portable guard tests
(with Linux process/link guards skipped on Windows); the external-tool observation
is opt-in and is never claimed by CI merely because unit tests pass.
