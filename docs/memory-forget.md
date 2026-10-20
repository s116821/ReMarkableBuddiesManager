# Forget one prepared memory fact

Both companions support a separate, explicit preparation and confirmation of one
supported global memory value. Read tablet state, search, select **Inspect current
revisions**, then choose **Prepare forget preview**. Inspect the fresh fact, target
connection/boot and local or selected-group effect before choosing **Confirm forget
of this prepared fact**. A search result or prior inspection never grants write
permission. Missing, tombstone, conflicting, opaque or unsupported numeric content
cannot supply a confirmation preview.

Forget records a tombstone and preserves history. It does not purge records,
reclaim disk space, remove original documents or establish cloud propagation. A
successful acknowledgement identifies the original historical transaction. It
never proves the current fact is deleted: another value may have been written
later. Deliberately inspect current revisions to learn current state. Provenance
is author asserted, not independently verified.

## Cancellation, uncertainty and restart

One private request occupies the live helper or Electron main process. Tabs share
that slot; another preparation receives Busy without replacing the first target.
The public display reference expires after two minutes and can be claimed for
confirmation only once. Refresh, tablet reads, disconnect and other maintenance
invalidate ready confirmation, including same-identity reads. Preparation pauses
ordinary polling; a stale displayed preview cannot authorize another dispatch.

**Stop local wait** invalidates preparation or stops waiting for confirmation.
Stopping a wait does not roll back a possible commit. Missing, malformed, lost,
nonzero-exit or late confirmation replies remain unknown. No automatic retry,
replacement operation UUID, new preparation or fallback confirmation is sent.
An exact complete producer refusal can prove that confirmation invocation did not
attempt mutation; it does not erase uncertainty about a different earlier request.

For an unknown request, reverify the original wired target and boot, then choose
**Check historical receipt only**. This uses the same retained original private
bytes and performs a separate read-only lookup. Missing proof or changed bindings
remain unresolved; lookup never falls through to mutation. A previously retained
acknowledgement can be returned without another CLI invocation. Competing fresh
preparations stay blocked while the live host retains an unresolved request.

Private intent custody is in memory only. Renderer refresh can rediscover retained
uncertainty from the same host. A complete helper/app restart loses original bytes
and receipt-recovery ability; no retained record never proves no earlier commit.
A surviving UI preserves its unknown notice. A fully restarted UI cannot reconstruct
lost history. No localStorage, database, credentials store or journal persists this
request. After actual custody loss, fresh deliberate inspection/preparation is a
new user intent, not replay or reconciliation of the unknown operation.

## Fixed protocol and manual equivalent

The producer protocol is defined by the [prepared-forget contract](https://github.com/s116821/ReMarkableBuddiesDocs/blob/64ff69baf2e066f203eadd587cb2d3864173b1a6/openspec/changes/prepare-conditional-memory-forget/contract.md).
Use only these one-shot selectors with the existing explicit configuration:

```text
reader-buddy --memory-operation prepare-forget --memory-input -
reader-buddy --memory-operation forget --memory-input -
reader-buddy --memory-operation forget-receipt --memory-input -
```

Preparation accepts one JSON document `{prepared_version:1,operation:UUID,key:KEY}`
and EOF. Confirm and receipt accept `{intent:ORIGINAL_PREPARED_INTENT}` and EOF,
with the exact original values. The operation UUID is created once before preparing.
Keep private original intent securely for any manual receipt check; never rebuild
expected heads, configuration or pins from a later read. Older installed builds
may refuse capability. No release-version threshold or matching SemVer proves
support. Existing absolute-file maintenance remains separate; the Manager does
not stage remote files, use a Buddy admin API or offer arbitrary commands/paths.

The public helper route and IPC accept only prepare identity/key or an opaque
reference for confirm/receipt/cancel, plus host-only status. They expose no private
intent, expected hashes, mode/configuration bindings, selected-domain pins or raw
base64. Linux/Windows retain existing identity-verified wired callbacks, fixed env-i
HOME/PATH/configuration/Reader path and before/after route/boot checks. No Wi-Fi
management route, provider sign-in or running service is required.

Input/raw CLI report/private child/public response caps are respectively
131072/262144/360448/65536 bytes; public requests are at most 2048 bytes.
Raw reports require one UTF8 JSON line, zero exit, no duplicate/unknown fields and
phase-specific status/incomplete/outcome shapes. Stderr is discarded and capped
at 16384 bytes. Channel/collection/Python/Node/browser deadlines are 2/8/12/13/14
seconds. Overflow and partial data refuse the complete operation. Supported preview
numbers must be exact safe integers. The preview's typed Envelope canonical hash
must match the producer's original expected hash; private pin parsing never
recreates a live selection token or grants arbitrary-root authority.

## Public checks and evidence boundaries

Run `node --test tests/memory-forget*.test.mjs`,
`python -m unittest discover -s tests/memory_forget -v`, and
`npm run test:memory-forget-hosts` (add `-- --packaged` for retained packages).
Use the usual documented Node/Python/Playwright/headless display dependencies.
The child, route/report and SSH-peer fixtures are synthetic and use deterministic
public test identities. The 913-byte Rust Envelope golden is a separately attributed
serialization diagnostic, not actual preparation/Store/device execution. Browser
and Electron controls preserve real public session/IPC/coordinator guards while
replacing only lower transport/report methods. Native USB, provider, service,
installation and physical package qualification remain separate acceptance gates.


The exact corrected producer corpus is retained as
`tests/fixtures/prepared-forget-77e92306-corpus.json`, copied byte-for-byte from
[the immutable producer artifact](https://github.com/s116821/ReMarkableBuddies/blob/60940ac577aa25eb11573619e6c8ea7e86d74885/tests/fixtures/prepared-forget-77e92306-corpus.json).
It contains 39 actual Windows CLI request/stdout pairs captured from disposable
host Stores using production bodies promoted unchanged to 77e92306. All 78 hashes,
the exact original manifest string and nine literal Greek previews are verified;
all phase reports, preview hashes and public reductions pass. Local/selected
original reports also cross the real coordinator/controller with synthetic lost
confirmation replies and exact captured absent/later receipts. Those transport
faults remain synthetic. Capture-time executable digest was not retained and is
explicitly null. The original 35-case bfa corpus remains historical producer
evidence; it is not silently repaired or substituted. Publishing the corrected
artifact did not rerun producer cases or establish device qualification.
