# Restore an ordinary Buddy archive already on the tablet

Both browser/local-helper and Electron provide the same **Restore an archive already on this tablet** section. Read tablet state, enter the explicit absolute path of one compatible archive already on that wired tablet, then **Prepare additive restore preview**. This does not transfer a PC/network/cloud backup or initialize a clean/replacement tablet. The supported target is an existing ordinary local Store; shared, isolated, selected and generation4 restore remain separate capabilities.

The path clears from the draft and actual field on submission. It is not saved or shown in the preview. Review source and target manifest/object counts, additional manifests, media completeness and inactive configuration presence. Portable configuration may contain private model/endpoint/credential-reference information, but restore never activates settings or credentials. Native reMarkable documents/pages/ink are not restored. Intentionally omitted media is distinct from corrupt/missing promised objects.

**Confirm additive restore** is a separate deliberate once-only action. Existing supported history is preserved additively through the existing producer's guarded generation writer. The consumer never stops/restarts a service, repairs a Store, calls a running Buddy API, refreshes original conditions or automatically retries Apply. Unsupported, Busy, stale, corrupt, incompatible or oversized state refuses without inventing readiness.

Outcomes stay distinct:

- **Not dispatched:** this invocation did not enter the restore writer; it is not a claim about an older uncertain operation.
- **Not activated:** original Apply did not attempt CURRENT publication, but staged files may remain. No automatic cleanup, stage reuse or retry follows.
- **Unknown:** publication may have occurred or output was lost. Keep that original and use only its explicit read-only check.
- **Original restore disk state read back:** the original Apply verified its intended disk closure; runtime remains unverified.
- **Desired restore state observed:** a later Status sees the full intended current closure. It does not identify the historical publisher, acknowledge an original receipt, prove runtime readiness or turn an earlier unknown result into a verified original Apply.
- **Unresolved/refused check:** current intended closure is not proven. It does not prove rollback, settle older uncertainty or authorize replay.

**Check original desired restore state** sends only the host-retained original source/intent packet under its captured connection/boot. **Show original restores on this computer** reads bounded host memory without contacting the tablet. Earlier originals remain visible while a genuinely new restore is prepared within capacity; the new operation/reference never refreshes or retries an older one. Later operations may change an older desired closure, which a later old Status reports as unresolved current-state evidence.

Ready previews expire after two minutes. Original private Status custody lasts at most thirty minutes without renewal. Eight original row slots and thirty-two executing invocation ledger entries per reference are finite limits. An expired row still occupies its one slot; it does not block every new restore while other slots are free. Full capacity refuses without eviction. Host restart/expiry cannot reconstruct lost original bytes from a public reference or a newly entered path.

**Stop restore wait** targets the captured executing invocation, or the Prepare creator of an idle ready grant. A stale cancellation cannot revoke a newer action. Before a reference exists, Stop detaches only the local UI wait; bounded host preparation may still finish and temporarily remain Busy. Stop cannot roll back publication. Queued observation must settle before dispatch; stopped/expired continuations cannot dispatch later.

## Manual producer equivalent

Ordinary repository tools and the public producer contract suffice; no private account, plugin or board is required. Use the existing identity-verified wired SSH setup and fixed command below with selector exactly `prepare`, `apply` or `status`:

```text
/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json /opt/bin/reader-buddy --restore-operation SELECTOR --restore-input -
```

Send one bounded JSON packet through private stdin followed by EOF. Prepare is exactly `{restore_version:1,operation:NEW_NONNIL_UUID,source:EXACT_ABSOLUTE_TABLET_ARCHIVE_PATH}`. Read the full preview before authorizing mutation. Retain the returned original fourteen-field intent and exact source privately in bounded process memory; Apply and Status use exactly `{source:ORIGINAL_SOURCE,intent:ORIGINAL_INTENT}`. No path in shell arguments/environment/history, no raw packet logging/persistence, no second Apply, condition substitution, rollback or stage-cleanup shortcut. Status is explicit and read-only. Complete stdin/report cap is16,384bytes; the later original packet must fit before treating Prepare as usable. Preserve the existing finite transport deadlines.

The central `restore-ordinary-archive-companion` change owns the detailed consumer contract, literal vectors and current qualification record. The unchanged ordinary-owned-restore capability/archived producer contract owns safe roots, overlap, configuration/source fingerprint domains, ordinary Store custody, same-mutex additive publication and complete desired readback. Source/synthetic helper/UI results alone do not establish retained Windows/Linux, real tablet/native or runtime qualification; exact reviewed results must identify which gates passed.
