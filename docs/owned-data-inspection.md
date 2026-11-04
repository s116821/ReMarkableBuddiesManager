# Read-only Buddy-owned inventory

Choose **Read tablet state**, then **Inspect owned data** in the shared browser or
Electron UI. The bounded existing Linux wired adapter invokes one fixed installed
CLI: `/opt/bin/reader-buddy --inspect-owned-data`, with an empty environment except
HOME, PATH and the explicit normal nonsecret configuration at
`/home/root/.config/remarkable-buddies/config.json`. It never sources the service
credential environment. A custom service configuration is not automatically
adopted; this view describes only that explicit configuration's owned roots.
Missing configuration is reported unavailable, not an empty initialized Store.

This consumes the reviewed but unmerged Rust inspection increment
[`6b1b9fd539c33ced6ab56541ef332ba05e4ed693`](https://github.com/s116821/ReMarkableBuddies/pull/32)
and [Docs contract at4b425c9](https://github.com/s116821/ReMarkableBuddiesDocs/blob/4b425c9559fed5446a730d56bc9e68b6b8e80bb4/docs/owned-data-inspection.md).
An older installed binary or unknown flag is explicitly unsupported; there is no
minimum application version guess and no fallback Reader startup/Store recovery.
Unknown report schemas are unsupported. Invalid/oversized output is unavailable;
raw output, error details, saved text and credentials are never displayed.

Both editions reuse [wired setup](wired-observation.md). Static web deployments
have no tablet transport; browser users explicitly launch the authenticated
loopback helper. Electron exposes only parameterless observation, cancellation
and inspection IPC. Linux remains previously accepted. The separate Windows development integration reuses the repaired adapter from PR8; software fixtures do not qualify physical USB. macOS remains unsupported. No product WLAN SSH or Buddy admin API is introduced.
The report schema number is independent of Git-tag application versions.

Inspection pauses automatic tablet observations. The host verifies the configured
USB route/interface/source and pinned SSH identity, rechecks the tablet metadata
and boot, and matches the last observed connection. Disconnect, explicit re-read,
changed boot/connection and late replies clear/refuse the report. Choose Read
tablet state again to resume observations. Inspection has the existing overall
bounded deadline and cannot stop/restart a service. A running writer may return
busy; use a separate coordinated maintenance workflow if needed.

## Interpret sizes and consequences

Observed bytes are apparent file lengths per owned path. Complete total stays
unavailable for partial/busy/unsupported/unavailable reports. Sizes do not prove
allocated disk space, safe reclamation, current logical membership, verified media
contents or recovery completeness. Stored files and domain references are separate:
Conversation and Source can refer to the same media, so domain media totals are
nonadditive. Missing, uninspected, intentionally omitted and size-mismatched
references have separate counts. No category entry means no category observation;
it never silently becomes an inspected zero. Cache/diagnostic ownership may be
unavailable. Credentials, native documents, legacy cache and external transient
diagnostics are excluded. Export associations do not establish native-page health
or authorize deletion of third-party notes.

The UI shows each owned category's consequence; it offers no cleanup, export,
restore, credential/settings changes or provider login. Those broader REM-42 and
REM-37/41/52/53 contracts remain open. Installed package ownership/provenance and
installer compatibility remain independently unverified.

## Public verification

Use Node24.21.0 and the normal `npm ci`/README checks. Run `npm run check`,
`npm run test:wired-hosts`, `npm run test:owned-hosts`, `npm run package`,
`npm run test:package` and `npm run test:owned-hosts -- --packaged`. On headless Linux
use the README's virtual display. Python fixtures use pinned `host/requirements.txt`
and `python -m unittest discover -s tests/wired -v`.

Parser/controller tests cover incomplete/shared accounting, schema/unsafe values,
late cancellation and changed sessions. A local real SSH peer verifies only the
fixed command/read paths, old CLI refusal and sanitized errors. Host subprocess
controls prevent invalid/privileged fields reaching either renderer. Browser and
actual Electron fixtures exercise partial/complete/busy/unavailable/unsupported,
future/malformed reports, changed sessions, disconnect, sandbox isolation and
390/1280px layout. Packaged Electron checks exercise the actual executable and
bundled host modules. Synthetic values are not device/provider/native evidence.

Screenshots under ignored `test-results/owned-*-partial.png` complement DOM/adapter
checks. Durable review evidence belongs in linked PR comments, pinned to exact
source. No live tablet, private account or model access is required.

## Stored data including notebooks

The separate **Inspect stored data including notebooks** action consumes only
`--inspect-owned-data-v3`. The older **Inspect owned data** action and report1/2
parser remain available manually. There is no automatic fallback, minimum tag
heuristic, service startup or filesystem scraping. Both Linux and Windows hosts
invoke the Linux tablet CLI using the existing verified wired callbacks.

The new host validates the original UTF8 bytes, single JSON frame/LF, closed keys,
duplicates, original unsigned integer token spellings, decimal-string u64 counts
and accounting relationships before reducing the report. Node24.21.0 and the
pinned Electron44.4.5 runtime supply standard JSON.parse reviver source context;
a missing context fails closed. Raw counts are never converted to Number.
The public view excludes owner and generation UUIDs, lease custody details, raw
stdout and diagnostics. The fixed apparent-file-length basis and excluded
credentials/native-documents/legacy-cache/external-diagnostics scopes still apply.
Metadata may contain protected inline text; inspection is not described as
text-free. Archived media payloads are not needed for these accounting observations.

Physical files, overlapping domain references and included notebook metadata are
separate groups. Archived source metadata is included in Source; notebook plans
and stages are included in Conversations. Do not add these subtotals to physical
space or interpret records as requests, generated turns or visible notebooks.
Missing categories say **Not checked**, unknown byte aggregates say **Unknown**,
and observed zero stays zero. Complete requires all categories and known totals,
no issues and full reference coverage. Other statuses do not establish an empty,
healthy or recoverable Store. Current/retained formats do not prove running
software, upgrade or restore compatibility. Counts preserve every decimal digit.

The host acquires shared maintenance ownership before dispatch or peer
invalidation. Busy does not cancel another operation. A retained unconfirmed
Local-only choice stays unconfirmed; this read cannot reconcile or replay it.
**Stop waiting**, hiding the page and disposing the UI clear local delivery;
the already-started bounded host read may still finish. These paths do not send a
delayed global cancellation. Explicit observation/disconnect invalidates the read.

Raw stdout is bounded to32768 bytes including LF; discarded stderr to8192 bytes.
The private raw/base64 envelope is bounded to49152 bytes and public results to16384
bytes. Remaining deadlines are at most2s channel,8s collection,12s child,13s host
and14s UI including observation quiescence. Oversize, malformed, stale, nonzero or
late responses are refused without retry. CLI exits2/126/127 are unsupported;
a valid producer refusal is kept separately from an unsupported command.

Run `node --test tests/owned-data-v3*.test.mjs`,
`python -m unittest discover -s tests/owned_data_v3 -v`, and
`npm run test:owned-notebook-hosts` with its `-- --packaged` counterpart after normal
build/package checks. CI runs the actual browser/Electron host checks on both
supported OSes. Frozen raw vectors are synthetic lexical/arithmetic cases,
including huge opaque-file sums; they are not enormous valid media descriptors
or reachable-filesystem evidence. Host tests use synthetic transport and a local
SSH peer, and do not qualify a physical tablet or installed release.

The added validation and UI measured about632kB of initial production assets.
The explicit initial error budget is650kB (previously625kB); the400kB warning
remains. This modest feature budget adjustment does not disable bundle checking.
