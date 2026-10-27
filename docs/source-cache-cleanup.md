# Clean up one derived cache slot

The browser companion and Electron app expose a separate **Clean up a derived cache slot** section. Select an ID deliberately from this tablet's metadata snapshot or enter a canonical document ID. Inventory metadata is not permission to delete: **Prepare cleanup preview** freshly validates only the selected derived slot. It displays its ID and apparent file length, without displaying the payload.

**Confirm cache cleanup** is a separate action. It consumes that preview once; no automatic confirmation, reprepare, retry or fallback exists. This operation can remove only one existing normalized-sources-v1 derived slot. It preserves original PDF/EPUB/notebook documents, source history, durable data, media, memory and credentials. It performs no service restart, configuration change or provider operation. Apparent length is not allocated or reclaimable space; source freshness and runtime remain unverified.

A preview lasts at most two minutes. Changing target, starting a peer operation, closing the page or stopping invalidates the local preview. **Stop cleanup wait** targets only an already captured invocation. During an unreturned preparation it stops waiting locally; the bounded host preparation may still finish and its unused preview expires.

After a possible confirmation, a missing or malformed reply means **unknown**, never proof of cancellation or success. Do not confirm again. **Check original cache cleanup** uses only the host's retained original:

- **Unchanged** means that original derived slot remains unchanged; it grants no retry permission.
- **Conflict** means the original binding changed; it grants no retry permission.
- **Currently absent** observes the desired state now, without proving who removed it or whether the earlier confirmation succeeded.
- A refusal or unavailable original check leaves the historical outcome unresolved.

The host retains at most eight uncertain originals in memory. Private original material expires after thirty minutes from possible confirmation, without renewal by checks. Safe tombstones still count toward capacity and cannot revive private authority. Each original admits at most 32 invocation records, including its preparation and bounded cancellation fences; exhausted records cannot admit a new check. Host restart loses in-memory custody. A lost public response may leave local uncertainty after the host has already released a terminal original; it is shown as uncheckable rather than retried. No durable recovery or physical erasure of immutable runtime/OS copies is promised.

The same captured USB transport and fixed public CLI are used by both desktop hosts. The producer operates only on a Linux target; desktop Windows support does not imply Windows target deletion support. No WLAN, tablet, provider or native durability qualification follows from local synthetic controls.

Implementation follows the central [cleanup consumer change](https://github.com/s116821/ReMarkableBuddiesDocs/blob/main/openspec/specs/source-cache-cleanup-companion/spec.md) and unchanged [producer contract](https://github.com/s116821/ReMarkableBuddiesDocs/blob/main/openspec/specs/prepared-source-cache-cleanup/spec.md). The existing [inventory guide](source-cache-inventory.md) remains metadata-only. Component checks include `npm test`, `npm run test:source-cache-cleanup-hosts` and its `-- --packaged` retained-artifact form, plus `python -m unittest discover -s tests/source_cache_cleanup -v`. No private tools or tablet are needed for these synthetic checks.
