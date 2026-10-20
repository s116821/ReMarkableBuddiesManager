# Inspect current revisions of one memory fact

Both the browser/helper and Electron share this read-only action. Read tablet
state, search global memory, then choose **Inspect current revisions** on one
result. The search key selects the fact; the new detail is a fresh bounded read,
not a complete catalog or permission to edit/delete. No model/provider account,
running Buddy admin API or Wi-Fi tablet route is used.

The view shows every admitted current head. Local competing heads are a conflict;
no array order, confidence or timestamp chooses a winner. A deletion record
(tombstone) has no current value but does not erase historical records. No current
heads means only that this requested key has none in the admitted view. Search
can omit conflicts, expired facts or tombstones and cannot discover every record.
Fact provenance is author asserted, not independently source verified.

Selected memory retains the producer's strict whole-view projection: conflicts or
invalid domain/ownership/custody state, even in unrelated registered data, can
refuse the entire inspection. Refusal stays unavailable with the actual incomplete
flag; it never becomes an empty array, local fallback or a selected conflict array.
An opaque/unsupported raw local head likewise refuses the whole consumer view.
Every returned record ID is verified against the canonical Key's UUIDv5, including
null-payload tombstones. Unsupported numeric values outside exact JavaScript
integers are refused without rounding or filtering other heads.

## Supported contract and manual equivalent

Producer contract is the proposed [inspect stdin packet](https://github.com/s116821/ReMarkableBuddiesDocs/blob/86bb4c0a594666b98135d6552fd3504a488af4a7/openspec/changes/inspect-memory-fact-over-stdin/contract.md).
Its implementation/qualification and actual producer compatibility remain delivery
gates for this consumer. Current installed older builds can refuse the operation;
that is unsupported/unavailable capability, never successful empty data. No
release-version threshold or installed capability is inferred from equal SemVer.

The supported one-shot command is:

```text
reader-buddy --memory-operation inspect --memory-input -
```

Use the existing explicit absolute configuration with the configured profile and
owned paths, send exactly one Key JSON document on stdin, then EOF. The Key has
profile, scope:{kind:"global"}, fact, with the exact profile/fact UUIDs selected
from search. The configured profile remains authoritative. No operation/expected
heads, commands, remote staging files or paths are accepted from the renderer.
Existing absolute-file maintenance APIs remain separate manual interfaces; the
Manager does not fall back to them or /dev/stdin. Selected memory requires the
existing matching registered SharedGroup configuration; no mode setup is added.

The host uses its existing env-i HOME/PATH/configuration and fixed Reader path,
identity-verified Linux/Windows wired callbacks, route/trust/boot checks and
before/after observation. Request cap is1024 UTF8 bytes. Raw CLI report cap is
262144 bytes including newline, smaller than the generic backend limit. Private
child/public envelope caps are278528/270336. Stderr is discarded and capped at
16384. Exactly one UTF8 JSON line with no duplicate fields and a zero exit is
required. Overflow, partial output or unsupported shapes refuse without truncation.
Channel I/O/collection/Python/Node/browser deadlines are2/8/12/13/14 seconds.

Cancel, a new search, refresh/tablet read or disconnect clears details, including
same-identity refresh. Late results cannot restore them. Details and selected keys
are not persisted in settings or logs. Success describes the admitted view at
receipt, not continuing freshness, native state, sync readiness or write authority.
Busy does not stop/unlock a service; retry later or use the separate maintenance
procedure. Ordinary Store opening can perform existing owned recovery, so domain
read-only is not a guarantee of no filesystem writes.

## Verification boundaries

Focused public controls are `node --test tests/memory-inspection.test.mjs`,
`python -m unittest discover -s tests/memory_inspection -v`, and
`npm run test:memory-inspection-hosts` (add `-- --packaged` for retained packages).
Use documented host dependencies/headless display setup. Actual local SSH peer
checks exercise fixed command/Key bytes/EOF/channel/trust with public deterministic
test keys and synthetic route/report fixtures. UI checks keep real HTTP/session/
IPC guards while substituting semantic reports/transport methods. Actual producer
stdin specimens must be attributed separately before compatibility delivery.
No physical USB, deployment, provider, model or native-page qualification follows.
