# Check an archive or export Buddy history

Use the shared **Check an archive or export Buddy history** panel in the browser
helper or Electron app after reading the state of the wired tablet. Enter a full
folder path on that tablet. A computer/network-drive folder is not a tablet path.
The path clears on submission and is never included in a result or saved draft.

Choose **Inspect archive** to validate an existing archive in full. It reports
media completeness and whether saved settings are present, keeping their values
private. Counts and format details are optional technical information. A valid
archive is historical custody: it does not prove current source freshness, restore
support, running Buddy health, or that native pages have arrived. Intentionally
omitted media is reported separately from missing promised bytes, which refuse
validation. Current inspection understands ordinary, selected-history and existing
feedback archives (formats1/2/3); unknown formats refuse.

To create a selected-history archive, enter a **new** destination outside Buddy's
data/cache/credential roots, choose **Preview history export**, review the content
and exclusions, then choose **Confirm history export** deliberately. This copies
supported Buddy history and media while keeping current records. It excludes saved
settings, credentials, native documents/pages, caches and runtime files. The
explanation does not freeze the source, provide source counts, reserve a tablet
folder or guarantee success. Counts come only from a completed producer report.
The source must already support selected-history export; feedback stores and
unsupported formats refuse. No ordinary-export fallback or Store repair occurs.

This creates an archive on the tablet. It does not transfer/download it to this
computer or the cloud, restore selected data, initialize a replacement tablet or
activate a sync group. Existing ordinary archive export/restore are separate.

An export runs at most once per captured preview. If its result is unconfirmed,
use **Check export folder** for that same earlier attempt. The check validates only
the original folder under host custody. A valid archive found there now does not
identify its publisher or confirm the earlier export. Failed checks do not prove
rollback. No automatic retry, overwrite, staging deletion or cleanup follows.
A genuinely new attempt requires a new deliberate preview; existing destinations
still refuse, including any staging left by an earlier attempt.

**Stop archive wait** ends its captured wait/operation; it cannot undo a finished
export or cancel a newer operation. Queued actions stopped before dispatch do not
start later. Previews last at most two minutes; private original check details
last at most thirty minutes without renewal. Eight retained attempt slots include
expired safe rows; thirty-two invocation entries per original are finite. Full
capacity refuses without evicting or reconstructing old originals. **Show earlier
exports** reads safe host memory only. Restart/expiry does not provide retry rights.

Manual equivalent: use the producer's
[fixed archive commands](https://github.com/s116821/ReMarkableBuddies/blob/68e42968b4c58b6f8ed1102078d78b40fad33ffc/docs/host-selection-archives.md)
with private bounded `{ "path": "/absolute/tablet/archive" }` stdin and
`--archive-operation inspect|export-selected --archive-input -` on the tablet.
Select a valid configuration through the documented environment for export;
inspection needs no Store/configuration. The current source inspector additionally
accepts feedback format3, although that older command guide describes1/2 only.
Follow producer-owned path/ownership/closure rules; no private account or plugin
is a contributor prerequisite. This guide describes the implemented consumer
contract, with current qualification recorded in the paired central change.
