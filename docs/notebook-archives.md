# Check or export Buddy notebook data

Both companions offer **Check notebook archive** and a separate **Preview notebook export** / **Confirm notebook export**. Enter an absolute folder path on the tablet. A computer or network-drive folder is not a tablet path. Export needs a new folder under an existing trusted local parent outside Buddy data, cache and credentials. Existing ordinary notebook storage must support the operation; no initialization, repair, mode change or fallback runs.

The preview explains intent and exclusions. It does not inspect/freeze the source, reserve a destination, promise counts or guarantee success. Confirmation consumes that original preview once. Original Buddy records remain. The complete archive preserves notebook lineage and reachable media, and may include an existing saved-configuration snapshot. That snapshot can contain private endpoint/model or credential-reference text: treat the archive as private. Credential contents, native reMarkable documents and native pages are excluded.

The archive stays on the tablet. Copy it off-device separately for protection against tablet loss. Manager transfer/download, network-drive/cloud backup, restore, cross-actor mapping, synchronization and runtime activation are separate. A valid detached archive proves current closure under a trusted local filesystem/quiescent archive assumption. It does not establish current source freshness, running Buddy health, restoration support, native page arrival or historical publisher.

Paths retain exact scalar text, CRLF and trailing characters without trimming or normalization. Unsafe/ambiguous edits refuse. Raw path cap is4096 UTF8 bytes; full encoded requests cap16384 bytes, so heavily escaped values can refuse earlier. Draft/model/textarea clear before the first wait and on refresh, disconnect, pagehide, hidden-page lifecycle, maintenance, expiry or destruction. Paths never appear in reports, saved drafts or logs. No JavaScript memory-erasure guarantee is made.

Preview authority lasts two minutes. The command can run and explicitly refuse before archive writes; this is shown separately from a request never dispatched. An unconfirmed result means export may have created a partial directory or published a marker. No automatic retry, overwrite or staging removal follows. **Stop notebook wait** targets only its captured invocation; it cannot undo an export or cancel a newer operation.

**Check original notebook folder** uses the exact host-held original path. Finding a valid complete archive there now does not change the earlier export result or prove who wrote it. A refused check does not prove rollback. **Show earlier notebook exports** reads safe host memory only, with no tablet I/O. A new intentional export requires a new preview and destination; spent previews cannot be reused.

At most eight original attempt slots and thirty-two invocation entries per original are retained without eviction; thirty-two queued cancellation fences are bounded. Original private check details expire after thirty minutes without renewal; safe expired rows remain. Renderer reload can recover only safe references from the same host process. Host restart loses those diagnostics without settling disk outcome or granting retry authority. The fourteen-second UI wait and bounded transport can expire on large archives; uncertainty remains conservative.

## Manual equivalent

The existing fixed producer commands take one bounded JSON document on stdin:

```text
/opt/bin/reader-buddy --archive-operation export-notebook --archive-input -
/opt/bin/reader-buddy --archive-operation inspect-notebook --archive-input -
```

Input is exactly `{ "path": "/absolute/tablet/archive" }`. Export uses the explicitly selected existing protected configuration via the documented REMARKABLE_BUDDIES_CONFIG environment. Detached inspection ignores configuration/Store. Require one complete matching report AND successful exit: even a success-looking frame can precede an output/witness failure. Never interpolate the path into a shell command, log private packets, automatically retry or delete incomplete output.

See the [producer contract](https://github.com/s116821/ReMarkableBuddiesDocs/blob/3fa30982e55d8405cfdb28d2823a8deb0e024f81/openspec/changes/archive/2026-11-04-expose-notebook-archive-maintenance/contract.md). These commands are manual alternatives; this guide does not authorize automatic tablet execution. Legacy archive inspection/export/restore remain separate unchanged operations.
