# Personalization editor

Both the local browser/helper and Electron Manager can inspect and edit the
supported Buddy configuration field through the hard-wired SSH host adapter.
Owning central change is `manager-personalization`. This uses the real fixed CLI
from [Rust PR39 source ac60b62f](https://github.com/s116821/ReMarkableBuddies/pull/39)
and its [pinned public interface](https://github.com/s116821/ReMarkableBuddiesDocs/blob/66e8d9b1cc8efd8d971174c2594d6dd05e813fdb/docs/personalization-config.md).
Unmerged source parents and actual deployment qualification remain prerequisites;
an older installed Buddy must refuse rather than accept a fabricated field.

Read tablet state, then Read personalization. A valid response shows the exact
saved text and enabled flag. Save preserves valid multiline Unicode and leading
and trailing whitespace. Unchanged original CRLF/lone-CR line endings survive
DOM editing; paste uses the clipboard's exact plain text. Newly typed newlines
use the textarea's input convention. The field is limited to16,384 UTF-8 bytes,
not16,384 characters, and NUL or malformed Unicode refuses. Disable retains the
saved text; Clear resets it to empty and disabled. These actions preserve other
configuration, conversations and learned handwriting records.

A successful mutation says **Saved on disk — restart required**. It verifies
only the backend's configuration readback. Inspect says running activation is
unverified. The editor never stops/restarts a service, queries a Buddy admin API,
or claims the setting applied to a running/in-flight/next request. A held runtime
or maintenance lease reports busy: use the separately qualified manual maintenance
procedure before writing. This increment does not implement controlled restart.

Every mutation uses the whole-config revision from the last valid inspection and
binds to the observed wired connection/boot identity. Concurrent changes require
new inspection; no automatic write retry occurs. A failed/cancelled/timed-out
response after possible dispatch is an **unknown outcome**, even if the old value
is still visible elsewhere. Inspect fresh before deciding what to do. Disconnect
or changed identity discards the old success/activation assumption. Draft text is
not written into localStorage, host settings or routine logs.

The authenticated helper has one fixed `/manager-personalization` route, a
131072-byte canonical JSON request, strict UTF-8 and existing exact Host/origin/
HttpOnly session guards. Electron exposes one narrow main-frame method. Requests
carry fixed operation, opaque connection/boot identity, and only the actual
allowed revision/text/enabled fields. No caller-defined path/command/environment
or service action is accepted. Before dispatch, the host reads the Reader service's
launcher and selects a known executable: `/home/root/.local/lib/remarkable-buddies/reader-buddy`
for the installed RM2 package or `/opt/bin/reader-buddy` for standalone installs.
A standalone CLI can also be used when there is no Reader unit or launcher.
The host runs the fixed personalization operation against the usual config path.
Service launch arguments stay with the service. Personalization text travels as
encoded JSON through child/SSH stdin. Existing host trust, bound USB interface/source route, credential custody
and change notifications remain required. Connection fingerprint must match before
dial/auth; boot must match before the command, with observation/route brackets
and timeout/cap afterward. The public transport label is now wired-maintenance,
not a promise that arbitrary management or restart is supported.

The fixed Python process is12seconds and host13seconds. CLI stdin/stdout are bounded
at131072 bytes; the host response adds a bounded observation envelope (139264 total).
Stderr is discarded/capped and diagnostics are sanitized. Server-side last-inspect
revision and exact set/disable/clear readback are checked before a verified UI result.
No actual physical tablet mutation was executed to qualify this increment.

### Save the first configuration

Connect over USB, stop Buddy and read tablet state in Manager. Open **Tablet → Setup → First configuration**. **Check current configuration** reads the current state. To save missing defaults, select **Review first configuration**, then **Save default configuration**. Buddy checks the existing local Store and saves a default file only when it can preserve the existing data. Once a valid file is present, open **Personalization**, read the saved revision and edit the preference.

An unconfirmed save can be followed by **Check current configuration**. The check reads the current file and leaves the original result unconfirmed. Manager does not retry the original save. Clean and replacement setup retain their separate empty-root checks.

For an existing installation, the wired host requires the known resident launcher and checks that its executable digest matches the reviewed executable before saving. The digest binds the check and save to the same observed bytes. Package signature verification remains part of package installation.

Public focused checks:

```text
node --test tests/personalization*.test.mjs tests/first-configuration*.test.mjs
python -m unittest discover -s tests/personalization -v
python -m unittest discover -s tests/first_configuration -v
npm run test:personalization-hosts
npm run test:personalization-hosts -- --packaged
```

Use the supported Node/Python/host requirements and documented headless wrapper.
Owned SSH channel tests exercise maintained Paramiko and byte-preserving fixed
command/stdin with explicit synthetic CLI responses, not a real Buddy config write.
Shared UI checks substitute synthetic inspect/save/conflict values and preserve
actual sandbox/IPC invalid-input refusal; they do not prove USB, runtime activation,
provider behavior or deployment. Never capture real personalization text in public
screenshots or copy raw config stdin/stdout into issues. Backend real temporary
Store/config/CLI receipts are separately owned and attributed, not rerun or relabeled.
