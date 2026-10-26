# Source-cache slot inventory

In the browser or desktop Manager, read tablet state, then choose **Inspect source-cache slots**. The explicit snapshot lists at most sixteen canonical document identifiers, each slot's apparent file length, and this namespace's total. An inspected empty list is distinct from unavailable, unsupported, busy, or conflicting metadata. Connecting, reloading, and waiting do not inspect automatically.

Slot contents remain unread and unvalidated. Identifiers are metadata, not titles or cleanup grants. The snapshot does not establish source freshness, active runtime behavior, allocated disk space, or reclaimable space. Never add its namespace total to the aggregate owned-data total. There is no row selection, payload view, or cleanup operation in this surface.

**Stop waiting for cache inventory** clears the local snapshot and detaches the renderer wait. The bounded host read may continue; another maintenance request may receive Busy until it finishes. Stop sends no cancellation command. Peer edit starts, saves and original-status checks clear the snapshot. An admitted inspection clears idle maintenance editors and private input synchronously; retained uncertain original operations and their original expiry remain independent.

## Transport boundary

The optional `inspectSourceCache` capability accepts only `connection_id` and `boot_id` through guarded same-origin HTTP or main-frame IPC. The host acquires the shared maintenance owner before hooks, cancellation or I/O. Busy does not invalidate editors or issue a command. The host uses the captured raw observer and fixed `--inspect-source-cache` command with fixed environment/configuration and zero stdin. The target is Linux; Windows and Linux Manager hosts use their existing identity-verified transport. No installed-version threshold is used.

The helper budget is at most 12 seconds, host deadline 13 seconds, and renderer total wait 14 seconds including connection pause. Reusing a paused connection does not send another global cancel. Token, epoch and renderer-generation guards prevent late results, deadlines and finalizers from affecting a later owner or snapshot.

Original producer bytes are bounded at 8,192, strictly decoded as UTF-8, checked for recursive duplicate keys and single-line framing, and validated completely before reduction. Only the safe nine-field metadata view reaches the renderer. Owner/generation identifiers, raw stdout, stderr and transport errors do not. Future report versions yield unsupported without a candidate list. The public envelope is capped at 8,192 bytes; private helper envelope at 16,384 bytes. Caller requests cannot choose actions, paths, selectors, filters, paging, budgets or cancellation.

Local synthetic tests qualify report boundaries, real shared-owner exclusion, preserved uncertainties/expiry, private clearing and local Stop. They do not qualify any actual tablet, provider or runtime adoption.
