# Saved model and endpoint

Begin model settings edit reads only whether each saved declaration exists and its
origin. Existing model/endpoint text stays private. Each row offers Keep unchanged,
Replace, or Remove override, including an explicitly empty declaration. Replacement
text is opaque: no URL parsing, trimming, provider check or automatic normalization.
Model accepts nonblank scalar text up to256UTF8bytes; endpoint up to2048bytes.

A replacement is visible only while you enter it. It can contain sensitive text;
keep it out of screenshots or copied diagnostics. The app does not persist drafts,
auto-fill them from the tablet or log them. Pasted CRLF/trailing/control/Unicode is
kept in the private draft despite textarea display normalization. If an edit cannot
be represented safely, enter a fresh replacement. Submission clears the draft before
waiting; failure never restores or silently retries it. Closing, refresh, disconnect,
other maintenance, Stop and the two-minute edit limit also clear the draft. This is
reference/buffer lifetime management, not guaranteed JavaScript/OS memory erasure.

One Save prepares original inspected conditions and applies at most once within
one deadline. A no-change response is valid: an opaque replacement may already be
saved even though it was never read back. Verified means exact saved disk readback,
with restart required; CLI/environment overrides or a running provider remain
unverified. This editor does not restart Buddy or contact a provider/service API.

If apply may have run without a complete result, the host retains up to eight
original hash-only recovery records, without the raw patch for retry. Check model
desired file uses the original intent only. A match says that whole desired file
is present; it cannot identify a historical publisher or prove runtime activation.
Nonmatch is unresolved with no current string/field projection. A later refused
check does not prove rollback. Reload can recover only this host's in-memory
references; full host restart may lose recovery. No automatic status/reapply occurs.

The fixed producer commands are:

```text
reader-buddy --model-settings-operation inspect
reader-buddy --model-settings-operation prepare --model-settings-input -
reader-buddy --model-settings-operation apply --model-settings-input -
reader-buddy --model-settings-operation status --model-settings-input -
```

The trusted host selects the existing absolute config file. Inspect has no stdin;
prepare/apply use a bounded private patch, while status accepts only the original
hash-only intent. Follow the [producer contract](https://github.com/s116821/ReMarkableBuddiesDocs/blob/main/openspec/changes/archive/2026-10-20-edit-saved-model-settings/contract.md)
for manual JSON/version/hash rules; never substitute general/basic inspection,
refresh a failed Save's conditions or print real replacement values as examples.
No arbitrary file, alternate command, config fallback or credential operation follows.

Model, basic settings and memory-forget share one maintenance I/O owner. Busy and
old targeted cancellation cannot cancel a different owner. Existing basic/general
contracts and their limits remain unchanged; only the new model request path permits
its separately bounded replacement payload. Local SSH/host fixtures and attributed
captured reports do not establish USB device or running-provider qualification.
