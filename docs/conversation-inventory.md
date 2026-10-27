# Inspect conversation IDs

After reading the state of an identity-verified wired tablet, choose **Inspect conversation IDs** in either the browser/local helper or Electron Manager. The installed Buddy must implement the separate Linux `--inspect-conversations` report. No application version threshold is used to claim support.

The explicit snapshot shows at most sixteen sorted Buddy-owned conversation root IDs and their count. No titles, transcript or native page identifiers are requested. Inspection reads bounded persisted owned payloads under the producer's existing ordinary-store and inactive-unit custody. It never stops a service, repairs storage, selects a conversation or grants deletion permission.

A complete empty snapshot means no current supported conversation IDs were observed, not empty storage or absent retained history. Busy, unavailable, conflict, unsupported and too-large refuse without a partial list or fabricated zero. Larger or incompatible stores may refuse even if a particular conversation is small. Native bindings, runtime health, deletion eligibility and reclaimable space remain unverified.

**Stop waiting for conversation IDs** clears local waiting and the snapshot. It does not cancel a remote command or release host custody; the original bounded host read may finish and another operation may briefly receive Busy. A late reply cannot repopulate a stopped or newer view. Disconnecting, reading tablet state, changing boot/target, hiding the page or starting another admitted maintenance operation invalidates the snapshot. There is no automatic polling, retry or persistence.

Both hosts use the same fixed existing USB/SSH trust and identity checks. Requests contain only the observed connection/boot identity; callers cannot supply a command, Config path, conversation ID, filter or budget. The manual producer equivalent uses the existing explicit absolute `REMARKABLE_BUDDIES_CONFIG` selector and `reader-buddy --inspect-conversations`; see Buddy's public conversation-inventory manual and the central historical-conversation-inventory contract for exact storage/mode/service limits. Keep private arguments out of arbitrary command-line parser diagnostics.

This inventory provides no row actions. Later conversation management requires deliberate selection and a fresh separately admitted inspection/preparation. It does not expand selected/shared/isolated/feature layouts, install/restore/rollback, provider authentication or a running Buddy API.

Source and controlled host tests are distinct from real supported-device and native qualification. The central `manage-conversation-discovery-companion` change owns the complete paired implementation and review lifecycle.
