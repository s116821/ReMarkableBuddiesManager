# Owned-data inspection fixture provenance

`owned-report.mjs` is synthetic UI/reference accounting data modeled against Main's
report_version1 contract. It is not an actual device inventory.

`main-6b-owned-reports.json` contains actual Linux CLI outputs from unchanged Main
source `6b1b9fd539c33ced6ab56541ef332ba05e4ed693`, archived from Git and built locked,
offline/all-features with Rust1.98.1 and its committed SDK d01b4bd. Git build metadata
is unavailable outside a Git checkout; these are host protocol fixtures, not release
or native-production qualification. No Rust source/manifest/pin was changed.

An external temporary helper linked the actual compiled Main library and serde_json
artifacts to create an ordinary empty Store/config and synthetic credential sentinel,
then held its normal writer lease. The actual reader-buddy --inspect-owned-data
subprocess returned busy. After the helper released its lease, it returned complete;
a temporarily renamed fixture cache root produced partial; a missing explicit config
produced unavailable. Each inspection preserved every fixture file's content/path/mtime,
created no files, emitted no stderr and disclosed no sentinel. Fixture setup/renaming
are host test preparation, not actions performed by the inspector. All temporary
stores were removed. Only sanitized report bodies remain here; IDs belong to that
synthetic Store. No tablet/provider/authentication or media/native proof.

The test feeds these actual reports to the shared Manager parser without changing
status or complete-total presence. Regenerate using Main's public Store/Config APIs,
a cooperating lease holder, explicit nonsecret config and the actual inspection CLI;
no private account/agent is required. Runtime UI evidence at Manager2da remains valid;
this adds protocol fixtures only and does not change the reviewed backend or UI.


## Main626 memory query reports

main-626-memory-reports.json contains actual stdout from unchanged runtime626c2f818ad335f6aa49e5a9e88a739267b270cb (locked SDK5c0bc303bb9b22e8e01bce9b2bd2a7fe47c8010e), Linux x64 Rust1.98.1. Built only the Reader binary from its immutable Git archive; source/manifest/lock/SDK pins unchanged. An initial offline build lacked the pinned SDK checkout; a normal locked fetch/build succeeded in58.18s. Binary SHA256cdcf357159abd518ab778cec53de38f3222fb3c800390c167f200d7f77813d12. No production/native build provenance is inferred from an archive.

Six sanitized actual reports: local-complete, local-empty, busy (actual owned-file lock held with flock), missing-store, invalid-input, selected-complete. Existing file-based put and selected initialize operations set up isolated temporary Stores; query itself uses stdin+EOF. Local and selected reports exactly match regular-file query output, including original fact IDs/asserted provenance and Unicode/CRLF. Missing/invalid requests do not create Store paths. No raw stderr was emitted; all owned fixture Stores were removed afterward. Existing controller/parser tests consume these exact outputs; renderer fixtures in memory-query.mjs are separately synthetic. This does not establish physical tablet, provider/model, native pages, restore, full domain coverage or installation authority.

## Saved-mode producer reports

`main-b1-saved-mode-reports.json` contains seven actual producer-owner Windows CLI
inspection reports from immutable source `b1fa8a60c547141ccd5e716611863f04f1efdb48`.
The original compiled binary SHA256 is recorded in the fixture; this consumer did
not rebuild or execute that binary. A fresh disposable local Store was explicitly
initialized/changed by the producer owner's existing one-shot commands, then
inspected to capture unconfigured, LocalOnly, isolated backup and shared group.
A missing Store returned Unavailable. An actual owned OS byte lock produced Busy;
temporarily malformed fixture identity produced Unsupported, followed by exact
restoration. Unsupported is not a selected-format qualification; valid selected
format2 remains supported by the producer.

Each bounded command returned status0, empty stderr, one report line no larger
than16KiB and activation_performed=false. This is a fresh attributed capture, not
the original CLI suite's retained stdout or a replay of that suite. The first five
compact-JSON-plus-LF hashes match those supplied by the producer owner. Busy and
Unsupported hashes were computed from its exact quoted compact output. Fixture
IDs/digests refer only to that disposable Store and contain no user credentials.

The actual reports feed the real private-report/reduced-view parser and shared
controller without changing statuses or snapshot identities. No selected-state
corpus, physical device/provider/native proof or full source lifecycle is inferred.
`saved-mode.mjs` is separately synthetic UI data. Its canaries verify removal at
both public host bridges and from renderer state. SSH-peer fixtures replay a
recorded report over an actual owned channel with synthetic route/notice state and
fixed publicly known test identities; they do not access a development tablet.

`memory-inspection.mjs` contains explicitly synthetic local all-head/tombstone and
selected-refusal UI/transport data. The UUIDv5 example follows the producer contract;
independent Python UUID generation checks canonical requested identity. Synthetic
reports are not actual producer stdin receipts or device observations.

`main-4e2-memory-inspection.json` retains13 actual producer-owner inspect-stdin
stdout/request strings and the original26 SHA256 values from candidate4e2f8dec.
Decode the outer JSON then hash UTF8 strings directly, never reserialize parsed
reports. The selected-after-refused-conflict report is the same healthy tombstone
as before the rejected setup attempt; selected-unrelated-refusal is the separate
actual whole-view CLI refusal. Disposable host Store/binary evidence does not
qualify deployment or native behavior. The synthetic peer/UI fixtures stay separate.
