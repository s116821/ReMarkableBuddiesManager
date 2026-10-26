# Saved model credential file

The browser and Electron companions can deliberately install, replace or remove
the protected credential file selected by the saved model credential reference.
Set that reference separately, then begin a fresh file edit. Begin shows only
whether the admitted saved file is present; its name, path, contents, mode and
fingerprints stay hidden. Choose Keep, Install (absent), Replace (present), or
Remove. Removing an absent file and replacing identical bytes can be confirmed
as no-change by the tablet producer.

New private text is saved as exact UTF8, including CRLF, CR, NUL, trailing spaces
and non-ASCII characters. Whitespace-only input is refused using Rust's exact
whitespace predicate, without trimming accepted input. Text is limited to 8192
UTF8 bytes; escaped JSON and original-condition overhead must also fit each
16384-byte producer packet, so some otherwise bounded inputs are refused.
Nothing is clipped, normalized, split or given an extra newline.

The entry starts empty and clears before Save waits, on action changes, other
maintenance, refresh, observation, hiding/pagehide, disconnect, Stop, expiry and
destruction. Raw input stays outside safe UI state and browser persistence.
Real content hashes, bindings and intents are confidential too. They never
enter safe results, logs, errors or copied diagnostics. Owned mutable buffers
are cleared and references dropped; immutable JavaScript/Python/IPC/SSH/OS
copies do not have a physical erasure guarantee.

A ready editor lasts at most two minutes from Begin. Save prepares once and
applies at most once within a 13-second host budget. Stop is not rollback. A
missing or invalid reply after possible apply stays unknown. Explicit Check
uses only the original intent and observes the original desired file; it does
not prove historical authorship, authentication, effective key selection or
runtime adoption. Authentication and runtime activation always stay unverified.

Original confidential reconciliation material lasts at most 30 minutes from the
first possible apply dispatch, without renewal by checks or reference/config
changes. Expiry disables Check and leaves an unknown/unresolved marker. The
marker still counts toward the eight-original limit; cancel cannot remove it
or free a slot. At capacity, another Begin/Save is unavailable. There is no
automatic retry, eviction, reconstruction, rollback or reset workflow. A host
restart loses its private inventory; a surviving renderer preserves its safe
unknown warning. A full process/page restart provides no durable recovery.
An empty restarted host does not prove an older operation never ran.

Reference changes and file changes are separate. To remove the old file, remove
it explicitly before switching/clearing its reference. No discovery or cleanup
follows a switch. Changed reference/config/root can make an old file Check
refuse; that does not settle the original or authorize following the new target.
File presence cannot settle an older reference edit either. No two-file
transaction, vault, root/permission repair, provider call or service reload is
performed. Missing or unsafe prerequisites refuse without repair.

All eight maintenance operations share one owner. Busy refuses before hooks,
cancel or I/O, and an old targeted cancel cannot release a newer owner.
Windows and Linux Manager hosts both call the Linux target producer; this does
not imply Windows target support or native Windows USB qualification.

For private manual JSON and current filesystem admission, follow the unchanged
[producer manual](https://github.com/s116821/ReMarkableBuddies/blob/main/docs/model-credential.md)
and [producer contract](https://github.com/s116821/ReMarkableBuddiesDocs/blob/main/openspec/changes/archive/2026-10-22-manage-declared-model-credential/contract.md).
Fixed selectors are `--model-credential-operation inspect|prepare|apply|status`;
non-inspect input uses only literal `--model-credential-input -`. Never paste
real private requests, raw reports, bindings, intents or hashes into diagnostics.
Host qualification uses synthetic inputs and local peers, separately from
tablet/provider/runtime qualification.
