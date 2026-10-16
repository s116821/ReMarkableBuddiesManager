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
