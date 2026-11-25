# Preferences files

Both browser and Electron offer Export preferences and a file picker followed by
an import preview and a separate confirmation. The V1 file includes only declared
Reader/Writer options, personalization and research policy. It can contain private
personalization text. Choose a private download location and check the resulting
file/permissions yourself; handing bytes to the browser save flow does not verify
that a durable file was saved. Manual file import creates no hidden tablet or
host artifact spool.

Import keeps omitted destination settings and children. Supported explicit empty
values remain saved declarations; they do not erase other settings. The preview
shows changed setting names and declaration presence, not values or personal text.
No-change does not apply anything. Configuration, credentials, device/group
identity, models/endpoints, memory, native documents and data archives outside the
three-setting format are not imported. Existing settings editors remain separate.

Read tablet state, choose a file of at most128KiB, review the preview, then confirm.
Confirmation can apply only the original preview and file, once. The preview
expires after two minutes or on refresh/navigation/other maintenance. The backend
admits only supported existing stores: legacy1 or ready ordinary notebook4 in
absent/LocalOnly mode. This does not set up a new/replacement store or cloud group.
A successful import verifies the saved whole file; Buddy's running settings and
provider authentication remain unverified. No automatic service restart occurs.

If an import may have run without a complete verified result, do not repeat it
blindly. The private host keeps up to eight unconfirmed original intents in memory,
without the imported text after the dispatch lifetime. Check original preference
file observes the exact original desired whole configuration; it does not reapply,
identify the historical publisher or prove runtime adoption. Failure/different
bytes do not prove rollback. A fresh deliberate review is a distinct operation and
does not settle old uncertainty. Host exit loses these private recovery references;
no persistent recovery journal or automatic retry is added.

## Preferences from a verified backup

Packaged Manager builds do not yet enable backup downloads or preferences review.
Drive sign-in alone does not enable them. This section describes the development
flow; real Drive and installed-tablet qualification remain unfinished.

When this flow is enabled, select a backup revision and download it. After
verification, read the destination tablet's state and choose
**Review backup preferences**. Manager shows the same reduced settings preview in
the preferences panel. Review it, then choose **Confirm preferences import**.
A preview or No-change result does not apply settings. The backup may come from
a different device; the preview belongs to the connected destination and boot.

The host reads only the portable preferences member from the verified backup.
It retires the private download stage before offering a preview. If cleanup
cannot be confirmed, no preview is offered and the original download reports
that uncertainty. Backup bytes, credentials and local paths stay out of the
preferences view. This action does not restore archived data or native pages,
initialize a replacement tablet, or activate Buddy's running settings.

Review consumes that verified download. Another preview or a separate data
operation needs a fresh selection and download. If Manager explicitly offers a
retry after Busy, the original download is still available; otherwise select it
again. There is no automatic retry after a lost response. The preview expires
with the original selection, no later than the normal two-minute preview limit.

While review is pending or ready, Stop, a new selection, a changed tablet or
Drive connection, or navigation cancels that original preview. Once Confirm
may have started an import, releasing the backup view does not discard its
recovery record. Use **Check original preference file** for that original import,
as described above; a later preview does not settle an earlier uncertain result.

## Manual commands and validation

Only explicit export returns file bytes to the save flow. Ordinary UI state,
previews and retained diagnostics exclude artifact, intent, text, paths and hashes.
Input filenames/MIME do not establish trust. Strict complete JSON/UTF8/schema and
inclusive size checks precede normalization or wired I/O. Duplicate/unknown members,
numeric version aliases and malformed/private phase correspondence refuse whole
input/output. Browser and Electron use the same guarded fixed wired operations,
one maintenance owner and the original remaining-deadline hierarchy.

The public manual producer selectors remain:

```text
reader-buddy --export-portable-configuration ABSOLUTE_CONFIG_FILE
reader-buddy --portable-configuration-operation inspect
reader-buddy --portable-configuration-operation prepare --portable-configuration-input -
reader-buddy --portable-configuration-operation apply --portable-configuration-input -
reader-buddy --portable-configuration-operation status --portable-configuration-input -
```

A trusted caller sets the explicit configuration environment for import operations.
Inspect consumes no stdin; other import phases take exactly one private object and
EOF. Status takes only the original intent, not the artifact. See the
[producer contract](https://github.com/s116821/ReMarkableBuddiesDocs/blob/69f90bb771b4366bec72cbb78f4517ef6de16911/openspec/changes/import-portable-configuration/contract.md)
and [consumer change](https://github.com/s116821/ReMarkableBuddiesDocs/tree/main/openspec/changes/archive/2026-11-06-manage-portable-configuration)
for exact bounds and privacy/custody semantics. Older binaries refuse the new
operation; Manager never falls back to direct Config edits or a Buddy admin API.

Tests include original Windows CLI reports from source contentse5bf3b8 and keep
its original dev.v0.73.0-dirty attribution and Windows path hashes. Node/Rust compact
artifact correspondence is checked against original bytes. Browser/Electron use
actual guarded host/file UI paths with synthetic lower transport; these tests do
not establish physical tablet, running Buddy, live provider or native qualification.
