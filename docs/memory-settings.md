# Saved memory declarations

Both companions can inspect and deliberately edit the supported saved
`memory.enabled` and `memory.profile` declarations. Begin saved memory edit reads
only the enabled boolean and declaration origins; an existing profile ID stays
hidden. Each setting has Keep, Set and Clear declaration actions. Profile setup,
selection, catalog and membership remain separate.

Saving a true enabled value or a profile does not activate automatic Reader
memory. Every result keeps runtime activation unverified, including verified disk
readback. Saving disabled does not disable explicit memory maintenance. No restart,
next-request, provider, native-page or profile-readiness promise follows.

Enter the exact new profile ID privately. The tablet validates its UUID spelling
and the whole configuration, including enabled/profile/selection consistency.
The companion does not trim or reformat it, repair selection, create/discover
profiles, or migrate/delete records. Missing, explicit null, declared false and
an existing empty memory object retain their producer-defined meanings. A no-op
keeps the existing file bytes and does not perform an apply.

A private replacement is visible only during entry. Keep it out of screenshots
or copied diagnostics. Drafts are not persisted, auto-filled from the tablet or
logged. Save clears the draft and actual input before waiting; refresh, pagehide,
disconnect, other maintenance, Stop and the two-minute editor limit also clear it.
A late result cannot refill it. This manages owned buffers and references; it is
not guaranteed erasure of immutable JavaScript, IPC or operating-system copies.

One explicit Save prepares the original inspected file/path and private patch,
then applies at most once within one deadline. Busy, changed conditions, expiry
or malformed results do not refresh or retry the write. An outcome can remain
unknown if apply may have run. The host retains at most eight original hash-only
status contexts, without the replacement patch or an automatic retry/eviction.
Check original memory save observes only whether the exact desired file is
currently present; it does not prove historical authorship or runtime activation.
A refused check does not settle prior uncertainty. A stopped, failed or late
check returns unknown without claiming a fresh successful read; the original
unresolved observation and digest-only intent remain available. Reload can recover only the
running host's in-memory references; restarting that host may lose them.

The fixed manual producer commands are:

```text
reader-buddy --memory-settings-operation inspect
reader-buddy --memory-settings-operation prepare --memory-settings-input -
reader-buddy --memory-settings-operation apply --memory-settings-input -
reader-buddy --memory-settings-operation status --memory-settings-input -
```

The trusted wired host selects the existing absolute configuration file. Inspect
has no stdin. Prepare/apply use the bounded original private patch; status takes
only the original digest-only intent. Follow the unchanged
[producer contract](https://github.com/s116821/ReMarkableBuddiesDocs/blob/main/openspec/changes/archive/2026-10-20-edit-saved-memory-settings/contract.md)
for exact JSON, hashes and refusal semantics. Do not copy real private values into
examples or substitute a fresh intent for an uncertain original.

Memory settings, research policy, model settings, basic settings, prepared
forgetting and ordinary export share one maintenance owner. Old targeted cancellation cannot revoke a
new owner. Existing Reader/Writer/selected-memory drafts and manual commands are
preserved. Host fixtures and historical Windows reports are distinct from Linux
durability, wired tablet, provider or automatic Reader qualification.
