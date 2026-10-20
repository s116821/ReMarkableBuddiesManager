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
