# Saved basic settings

Both companions support explicit set/clear of Trigger corner, Diagnostic level and
Save diagnostic images. Begin reads the saved declarations and their origins.
Untouched fields stay out of Save; Remove override removes that declaration even
when its current saved value is explicitly null. Diagnostic images may include page
content. This editor does not expose raw JSON, arbitrary paths or credentials.

Begin pauses automatic observations first. A ready editor expires after two minutes
or is invalidated by refresh/navigation/other maintenance, even for the same target.
Save internally prepares the original inspected revision and applies at most once
under one shared deadline. A successful result verifies the saved file and says
restart required; it does not restart a service or prove running/environment state.

If apply may have run but its complete result is unavailable, do not repeat Save.
The host keeps original private evidence for up to eight unconfirmed saves in memory.
Check desired file reads that original exact target only. A match proves the desired
whole file is currently present, not which process published it or runtime activation.
Other current bytes or later failed status requests do not prove rollback. A fresh
Begin is a distinct deliberate edit and does not silently settle older diagnostics.
Full host restart can lose recovery ability; there is no persistence or automatic retry.

Stop before apply is known not-dispatched when the host can prove that phase. Stop
after possible dispatch preserves unknown outcome. Cancelling an older diagnostic
cannot cancel a different current operation. Explicit old status is remote work:
it refuses busy during another invocation, and invalidates a merely ready editor
before it reads. Host-memory retained diagnostics do not contact the tablet.

The fixed manual producer operations are:

```text
reader-buddy --basic-settings-operation inspect
reader-buddy --basic-settings-operation prepare --basic-settings-input -
reader-buddy --basic-settings-operation apply --basic-settings-input -
reader-buddy --basic-settings-operation status --basic-settings-input -
```

A trusted host sets explicit REMARKABLE_BUDDIES_CONFIG to the existing config file.
Inspect consumes no stdin. Prepare needs its own original inspect base/path hashes,
new operation UUID and exact dirty changes. Apply/status use the original private
intent. Never substitute a general inspection hash, refresh a failed apply's base,
read/write arbitrary files or use a running Buddy service API. The
[accepted producer contract](https://github.com/s116821/ReMarkableBuddiesDocs/blob/82717f481005bfd403ec35c149dfbbf28805d156/openspec/changes/edit-saved-basic-settings/contract.md)
defines strict fields/phase evidence. Unknown old selectors refuse capability;
release equality alone is not a write grant.

Tests use synthetic local callbacks/SSH peers and attributed captured producer
reports. These tests do not establish physical target or running Buddy behavior.
