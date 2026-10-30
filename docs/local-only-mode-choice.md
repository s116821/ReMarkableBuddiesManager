# Choose a saved Local-only mode

In either companion, read the connected tablet state, then choose **Review Local-only choice**. An existing valid Buddy-owned Store is required. This does not initialize or repair one. Review the separately observed saved mode and confirm **Confirm saved Local-only choice** to record one original conditional choice.

Confirmation records a new epoch even if Local only was already saved. Stored history and media stay preserved. This action does not stop a service, delete remote backups, edit configuration/provider bindings, convert selected history for ordinary Reader, or activate/qualify runtime, sync, provider or native behavior. Existing **Read saved storage mode** remains a separate read-only capability.

The preview expires after two minutes. Another maintenance action, Read tablet state, disconnect, cancellation, page hiding or navigation invalidates it. Busy refuses without stopping a service or bypassing an owner. An old precondition is never refreshed or rebased automatically.

## Receipts and uncertainty

An acknowledged original choice is a historical saved receipt. Separately displayed current metadata is a snapshot, not ongoing runtime truth. An older receipt remains historical if a later epoch exists, even when both modes are Local only.

Stopping local waiting is not rollback. A write can commit before its response fails. Lost, incomplete or untrusted output after possible dispatch remains **unknown**; an incomplete unsupported response can also follow commit. The host retains that original unknown record and prevents another choice for the same target within this host lifetime.

**Inspect current mode separately** sends only inspect. It can show later saved metadata but cannot prove whether the uncertain original succeeded. There is no receipt lookup, mutation replay, retry/rebase or clear-uncertainty control in this slice. The producer's manual exact choose replay can mutate if an earlier call never arrived, so this UI does not present it as a read-only check.

Up to eight possible-dispatch records are held in the host process without silently evicting unresolved originals. Browser reloads and session invalidation preserve them. Host process restart does not preserve these in-memory records and is not reconciliation; it must not be interpreted as proof that nothing changed. Durable host recovery and deliberate original-operation replay need a separate contract.

## Interface and bounds

The distinct capability uses only the existing producer's fixed commands:

```text
reader-buddy --sync-mode-operation inspect
reader-buddy --sync-mode-operation choose --sync-mode-input -
```

The host privately retains the original actor/digest token, generated operation UUID and fixed Local-only intent. Only an opaque reference and reduced saved metadata/outcome reach the renderer. Request bodies, tokens, actors, operation UUIDs, fingerprints, binding/root fields and raw receipts never become public bridge data. A reference grants neither arbitrary command/path access nor a new choice.

Remote input/output is bounded to16KiB; output is strict duplicate-free UTF8 report-v1 in exactly one newline-terminated frame with activation_performed=false. Receipt operation, expected digest, fingerprint and Local-only intent are validated privately, with current/historical classification checked against both epoch and mode. Public input is at most512 bytes, private child envelopes at most24KiB, and reduced public output at most8KiB. The existing verified Linux/Windows wired adapters, fixed Reader/configuration paths, bounded channel collection and13s host/14s browser budgets apply. No timeout, EOF, output failure or cancellation resends a writer request.

## Evidence scope

The twelve `tests/fixtures/local-mode-choice-reports.json` cases are consistently sanitized synthetic derivatives of separately reviewed Windows CLI output from producer source `4eeaabef92245173ff136e9773c0416de2653466`. They are parser inputs, not original emitted bytes or valid integrity authority. Current source tests separately define selected-format preservation and post-commit/prefix-output uncertainty; copying them is not a new execution result.

Host/controller/channel tests and actual browser/Electron UI tests use synthetic lower transport/producer behavior while preserving the real coordinator, public guards and UI. Retained-package tests also verify packaged source resources and sanitized failure behavior. These checks do not qualify physical USB/native behavior, live providers/cloud, service control or installed-release compatibility.
