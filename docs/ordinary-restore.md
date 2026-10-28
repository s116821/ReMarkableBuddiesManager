# Restore an ordinary Buddy archive already on the tablet

Both browser/local-helper and Electron provide the same **Restore an archive already on this tablet** section. Read tablet state, enter the archive's full path on that wired tablet, then **Preview restore**. The preview explains how archived Buddy data will be added while keeping current records. It shows media completeness and whether saved settings are included separately without being applied. Credentials are not changed. Exact manifest/object counts and supported storage formats are available under **Technical details**.

The archive must already be on the tablet. This flow does not download a backup, set up an empty/replacement tablet, restore native reMarkable pages or check running Buddy. Some archive media may intentionally be absent; missing promised data or corrupt/incompatible archives refuse without inventing success.

The path clears from the draft and actual field on submission, is not saved and is absent from the preview. **Confirm restore** is a separate deliberate action. Buddy's guarded restore adds data without replacing current records. The tool does not restart Buddy, apply saved settings, change credentials or automatically retry a restore.

If the restore result is unconfirmed, use **Check this restore** instead of trying the same attempt again. A later check may find the expected data on the tablet; that does not change or confirm the earlier restore result. If a check cannot find the expected data, it does not prove earlier changes were undone. An attempt that stopped before updating current data is shown separately: temporary files may remain, and the tool does not automatically retry or remove them. Successful data checks do not verify running Buddy, native pages or activated settings.

**Show earlier restore attempts** reads only this computer's saved-in-memory attempt list. Earlier results remain visible while a genuinely new restore is prepared within capacity; a new attempt does not retry or refresh an older one. **Stop restore wait** stops waiting for the captured attempt, not its past effects. Before an attempt reference is known, a tablet-side archive check may still finish after the UI stops waiting.

Previews expire after two minutes. This process can keep private information for checking an earlier attempt for at most thirty minutes without renewal, with eight retained attempt slots and thirty-two executing actions per slot. Expired attempts still occupy their individual slots; available slots may be used for a new deliberate restore. Full capacity refuses without dropping older results. Restart/expiry cannot reconstruct a lost original from its displayed reference or a newly entered path.

Technical support is limited to ordinary format1 archives and an existing ordinary local-only Store. Shared, isolated, selected and generation4 restore remain separate capabilities. Read the technical contract for exact not-dispatched/not-activated/unknown/restored/desired-generation-observed distinctions; the plain UI preserves these distinctions and offers their raw state identifiers only in optional details.

## Manual producer equivalent

Ordinary repository tools and the public producer contract suffice; no private account, plugin or board is required. Use the existing identity-verified wired SSH setup and fixed command below with selector exactly `prepare`, `apply` or `status`:

```text
/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json /opt/bin/reader-buddy --restore-operation SELECTOR --restore-input -
```

Send one bounded JSON packet through private stdin followed by EOF. Prepare is exactly `{restore_version:1,operation:NEW_NONNIL_UUID,source:EXACT_ABSOLUTE_TABLET_ARCHIVE_PATH}`. Read the full preview before authorizing mutation. Retain the returned original fourteen-field intent and exact source privately in bounded process memory; Apply and Status use exactly `{source:ORIGINAL_SOURCE,intent:ORIGINAL_INTENT}`. No path in shell arguments/environment/history, no raw packet logging/persistence, no second Apply, condition substitution, rollback or stage-cleanup shortcut. Status is explicit and read-only. Complete stdin/report cap is16,384bytes; the later original packet must fit before treating Prepare as usable. Preserve the existing finite transport deadlines.

The central `restore-ordinary-archive-companion` change owns the detailed consumer contract, literal vectors and current qualification record. The unchanged ordinary-owned-restore capability/archived producer contract owns safe roots, overlap, configuration/source fingerprint domains, ordinary Store custody, same-mutex additive publication and complete desired readback. Source/synthetic helper/UI results alone do not establish retained Windows/Linux, real tablet/native or runtime qualification; exact reviewed results must identify which gates passed.
