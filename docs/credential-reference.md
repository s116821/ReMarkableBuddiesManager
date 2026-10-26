# Saved credential reference

Both browser and Electron companions can deliberately set or clear the saved
model credential reference. Begin reads only declaration origin and presence;
the current name remains hidden. Choose Keep, Set new private reference or Clear
declaration. New names use 1–80 ASCII letters, digits, hyphens or underscores.
Exact case is preserved. Whitespace and pasted line endings are refused rather
than removed.

This editor changes one saved reference. It does not install, discover, read or
remove a credential file, authenticate to a provider or revoke an active key.
Reference and file changes are separate operations; no atomic two-file setup is
promised. Existing CLI/environment/protected-file precedence is unchanged.
Every result keeps runtime activation and authentication unverified.

The private entry is cleared before Save waits, and on Clear, refresh,
observation, other maintenance, disconnect, pagehide/reload, Stop, expiry and
destruction. Names are not persisted or included in safe results or logs.
This clears owned buffers/references, without guaranteeing erasure of immutable
JavaScript, IPC or operating-system copies. Preserve unrelated drafts.

Save prepares against the inspected original and applies at most once within
one deadline. Only the producer's no-change report skips apply. Changed
conditions, Busy and expiry refuse rather than refreshing the write. A missing
reply after possible publication stays unknown; Stop is not rollback. The host
retains up to eight hash-only original status contexts without automatic retry
or eviction. Check original reference save observes current desired Config
bytes only, not historical authorship, file readiness or runtime adoption.
A later refusal never settles an older unknown result. A reference change can
make an older credential-file intent's Config binding stale; retain that file
operation's uncertainty separately instead of retrying or treating it as done.
Renderer reload recovers only a still-running host's references; host restart
may lose them.

The separate fixed manual selectors are inspect/prepare/apply/status through
`--credential-reference-operation`. Non-inspect input uses only literal
`--credential-reference-input -`. Follow the unchanged
[producer manual](https://github.com/s116821/ReMarkableBuddies/blob/main/docs/credential-reference.md)
and [exact producer contract](https://github.com/s116821/ReMarkableBuddiesDocs/blob/main/openspec/changes/archive/2026-10-22-edit-saved-model-credential-reference/contract.md)
for private JSON, original hashes and current custody. Keep private names and
intents out of copied diagnostics.

Reference/model/basic/memory/research/forget/export share one maintenance owner.
Old cancellation cannot release a newer owner; retained unknowns remain bound
to their own original. Synthetic host verification is separate from Windows
USB, tablet, provider, credential-file and runtime qualification.
