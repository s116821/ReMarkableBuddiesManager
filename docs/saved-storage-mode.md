# Read the saved storage mode

In either the browser companion (served by its configured local helper) or
Electron, connect with the existing protected wired USB/SSH setup and select
Read tablet state. Choose Read saved storage mode. This inspects an existing
Buddy-owned Store; it does not initialize one or choose/change its mode.

The panel distinguishes:

- No explicit storage mode saved: existing unconfigured legacy policy, not an explicit Local only choice.
- Local only (saved).
- Isolated backup (saved), with its saved backup ID.
- Shared group (saved), with its saved group ID.

The Buddy data device ID identifies owned storage metadata, not the tablet's
hardware serial. Saved epoch is an optional detail. These values do not prove a
running worker, successful sync, remote-group membership, provider readiness or
native-page health. Conditional write tokens, binding/root details and operation
receipts are validated privately and never sent to the renderer.

Busy means the Store cannot be inspected now. Try again later; this panel never
stops a service or bypasses its lock. Unsupported, missing/unavailable, failed or
refused output stays distinct from a successful unconfigured result. Older
installed binaries can reject the command; no release-version threshold or
private mode-file fallback is inferred. Missing helper/host setup remains
unavailable. A successful wired observation permits only the fixed capability
probe and does not qualify installation or native compatibility.

Cancel, Disconnect or Read tablet state clears the displayed result and ignores
late completion, including a refresh that observes the same connection/boot IDs.

## Manual interface and bounds

The backend's public [saved-mode guide](https://github.com/s116821/ReMarkableBuddies/blob/main/docs/host-sync-mode.md)
documents its explicit setup and separate mutation operations. This Manager
capability uses only:

```text
reader-buddy --sync-mode-operation inspect
```

It sends no remote input or caller-selected command/path. The existing supported
absolute configuration and owned roots must already be valid. The Manager host
reuses its fixed Reader/configuration locations and identity-verified Linux or
Windows wired callback; it checks connection/boot identity around the command.

Backend stdout is exactly one bounded UTF8 JSON report-v1 line, at most16KiB
including newline. Duplicate keys, invalid UTF8, malformed/partial/oversized data,
unknown shapes/versions, nonzero exit and changed identity cannot become a healthy
snapshot. The identity-only host request is at most256 bytes. Private child
envelopes are capped at32KiB; the reduced browser response at16KiB. The existing
2s channel I/O,8s collection,12s Python,13s Node and14s browser deadlines apply.
Stderr is bounded/discarded. No cancellation, timeout or refusal causes a mutation,
automatic retry, staging writer or service stop.

## Evidence separation

`tests/fixtures/main-b1-saved-mode-reports.json` preserves seven producer-owner
actual Windows CLI reports from a fresh disposable local Store at immutable
sourceb1fa8a60. Their scope, original binary identity, report hashes and exact
attribution are recorded in the fixture and its README. They are host protocol
observations, not installed-release or physical-tablet evidence. Busy used an
actual owned Store lock; Unsupported used malformed owned identity and does not
mean valid selected format2 is unsupported.

The owned SSH-peer controls exercise the actual fixed command, empty stdin and
bounded channel behavior with explicit route/notice/report fixtures and public
test identities. Browser/Electron tests use explicit synthetic semantic/transport
fixtures while retaining real host guards, renderer isolation and package-resource
checks. These evidence types remain distinct from physical USB, provider/model,
sync, restore, updater and native qualification.
