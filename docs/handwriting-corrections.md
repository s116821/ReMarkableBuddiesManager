# Inspect and remove saved handwriting corrections

Connect a compatible tablet over the configured verified USB link, then choose
**Read tablet state**. Both the browser and desktop companion expose the same
**Saved handwriting corrections** panel. This manages explicit saved records;
it does not measure recognition quality or train an external model.

Enter the logical profile UUID whose records you want to inspect. The profile is
an explicit grouping, not a discovered person or account. Optionally enter search
text, then choose **Search saved corrections**. A blank search requests a bounded
subset, up to eight usable records. Search uses the producer's plain text matching,
not semantic retrieval. Refine the search or supply a correction UUID for direct
inspection; partial empty results do not mean the profile contains no records.

Results contain private original/replacement text and caller-asserted provenance.
A source link does not verify tablet-page ownership. The sample's reported
availability is an observation from that command. Sample image display is not
available. Conflicted, unsupported or unverifiable records cannot be prepared for
removal by this companion. Subject memory and the personalization prompt are
separate settings and domains.

Choose **Inspect this correction**, or enter its profile and correction UUIDs and
choose **Inspect correction key**. For a complete supported single current value,
**Prepare removal of this correction** performs another fresh inspection. Review
the exact original text, replacement and revision. Only a separate **Confirm
removal from active use** submits the captured expected-head tombstone once.
Changing records may cause a CAS refusal rather than deleting a later correction.

Removal excludes that correction from active queries. Historical text, source
samples, retained revisions and existing backups remain. It is not physical or
secure erasure, a corpus wipe, provider synchronization or proof of recognition
improvement. The operation's acknowledgment describes its observed commit, not a
promise that no later revision can exist.

If acknowledgment is lost, retain the unknown original attempt. **Check original
correction removal** looks up its exact original operation without submitting
another mutation. A found tombstone is historical evidence; absence or refusal
leaves the original unknown. The original outcome and later check are shown
separately. There is no automatic retry, new-head substitution or resume on reload.

Private inputs clear on submission; content and confirmation clear on Stop,
refresh, disconnect, identity changes, another admitted maintenance action or page
lifetime changes. Prepared authority lasts at most two minutes. Minimal original
private identity for status lasts thirty minutes without renewal, at most eight
attempts and thirty-two checks per attempt. Expired safe metadata remains for the
host session; restarting does not reconstruct mutation authority. Another active
maintenance operation returns Busy without interrupting its owner.

The installed Buddy must support the exact `--handwriting` v1 query/inspect/forget/
status contract and ordinary local mode. Unknown versions, unsupported modes and
unsafe-integer reports refuse; there is no fallback to arbitrary commands or a
Buddy API. Inputs use protected stdin, not shell interpolation. Routine errors/logs,
URLs and browser storage do not retain correction content. JavaScript memory
clearing is bounded lifetime management, not cryptographic erasure.

Manual equivalents and the authoritative producer schema live in the
[central confirmed-handwriting contract](https://github.com/s116821/ReMarkableBuddiesDocs/tree/main/openspec/changes/archive/2026-10-26-retain-confirmed-handwriting-corrections).
Consumer contract, limits and qualification are maintained in central Docs. Local
fixture, synthetic localhost SSH and browser/Electron results qualify companion
mechanics only; they are not tablet/native/provider or recognition-efficacy evidence.
