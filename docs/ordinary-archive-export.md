# Export an ordinary Buddy archive on the tablet

Both companions can prepare an archive preview, then export once to the exact
absolute tablet destination you entered. The destination must be a new directory
under an existing safe parent, outside every Buddy data, cache and credentials
root. The producer checks current configuration, history, mode and destination
again before writing; a stale or occupied destination refuses. Existing ordinary
unconfigured/local-only storage is required. This does not initialize a new store,
stop a service, change synchronization mode or overwrite an existing directory.

This archive stays **on the tablet**. It does not protect against loss of that
tablet. Copy it off-device separately using a trusted manual workflow. Manager
transfer/download, cloud/network-drive backup and restore are separate features.
Native reMarkable documents and credential files are excluded. Portable
configuration can contain private model/endpoint or credential-reference text;
treat the archive itself as private. The preview states whether configuration is
included and whether media was intentionally omitted. All promised included
objects must verify; omitted media is not reconstructed.

The destination is sensitive input. Paste and later edits preserve exact scalar
Unicode, CRLF and trailing characters without trimming or path normalization.
The raw draft and actual textarea clear synchronously before the first prepare
wait and on refresh, pagehide, disconnect, maintenance, Stop, expiry or destruction.
Unsafe/ambiguous edits refuse rather than select a different path. Paths have a
4096-byte UTF8 limit; complete encoded requests and original private packets also
have bounded sizes, so some heavily escaped paths refuse below that raw limit.
No automatic draft persistence, path echo in reports or JavaScript memory-erasure
claim is made.

Preview authority lasts two minutes. Confirm uses its exact original conditions,
never an automatic reprepare or retry. Verified means complete matching archive
readback on this tablet, not service readiness or off-device durability.
Not-published can leave a partial destination directory. Unknown means the marker
may have been published. Do not delete or retry automatically in either case.

The host retains at most eight uncertain originals, including their private
exact destination and original intent, only in memory. Explicit original status
checks complete current closure at that same destination. It cannot identify a
historical publisher or prove the earlier command completed. A nonmatch stays
unresolved; a refused check cannot settle the original uncertainty. Renderer
reload recovers safe original references from the same host process without
polling or reapplying. Host restart loses those diagnostics without proving a
disk outcome. There is no automatic eviction of uncertain originals.

## Manual equivalent

The unchanged producer provides these fixed selectors, each consuming one bounded
JSON document on stdin, with one explicit absolute configuration selected through
`REMARKABLE_BUDDIES_CONFIG`:

```text
/opt/bin/reader-buddy --ordinary-export-operation prepare --ordinary-export-input -
/opt/bin/reader-buddy --ordinary-export-operation apply --ordinary-export-input -
/opt/bin/reader-buddy --ordinary-export-operation status --ordinary-export-input -
```

Prepare takes `{export_version:1,operation:UUID,destination:ABSOLUTE_TABLET_PATH}`.
After privately checking its preview, apply takes the exact unchanged
`{destination, intent}` returned/bound by that preparation; status uses that same
original packet. Never interpolate the destination into a shell command or log
private stdin/reports. Status is destination-only and does not reopen source
configuration or storage. The public
[producer contract](https://github.com/s116821/ReMarkableBuddiesDocs/blob/main/openspec/changes/archive/2026-10-20-export-ordinary-owned-archive/contract.md)
fixes the exact schemas, path/hash bindings and bounded refusal behavior. These
commands are manual alternatives, not permission for automatic device execution.
