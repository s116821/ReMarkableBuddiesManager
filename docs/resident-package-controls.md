# Buddy package controls

In either companion, read the connected tablet state and open **Buddy package
controls**. Review disabling startup, removing the owned package while preserving
user data, or replacing it with an independently approved release. Replacement
reviews show the installed and candidate versions, including downgrade consequences.
Confirm only the reviewed change. These controls currently report unavailable:
production package bindings and the separate Stop admission registries remain empty.
Source fixtures do not qualify a tablet, native recovery or signed installation.

If a submitted operation loses its result, use **Check original package operation**.
Checking never sends a service or package command. A verified intermediate step is
unfinished work: choose **Review remaining step**, then explicitly confirm that
single remaining phase. A possible Stop, disable or package submission is never
repeated. A verified Stop is not a completed removal or replacement. Stopping a wait
or cancelling a review does not undo a submitted change or clear its history.

The shared host and existing Python coordinator retain the original connection,
boot, activation and immutable goal. New goals use version4 of the existing protected
Stop intent; downstream records embed that exact original. All records remain
bounded to4096 bytes, including preflight of the downstream formats before Stop.
Legacy records retain their existing read-only behavior and cannot supply an inferred
continuation goal. No version is minted in source: displayed installed/candidate
versions come from separately qualified host policy and release artifacts.

A native process-lifetime lock on the original intent excludes a surviving writer,
including across Manager restart. Linux uses flock; Windows uses LockFileEx on one
byte beyond the bounded JSON, with narrowly scoped read sharing for the owned intent.
After restart, bounded protected discovery starts with unknown outcomes. Explicit
read-only phase proof and a fresh review/confirmation are required before one proven
unsubmitted phase can run. A live writer, changed context/candidate, malformed or
conflicting record, or failed final proof refuses continuation. Unsupported native
locking refuses; Windows behavior requires execution on Windows, not Linux mocks.

MaintenanceIO and the shared Stop/package submission fence preserve the original
goal's reservation through uncertainty, intermediate progress and cancelled reviews.
Only full goal-specific terminal proof releases it. Other controls cannot supersede
an unfinished goal. Every child/host/UI call retains its12/13/14-second ceiling;
continuation is a new separately reviewed invocation, never an extended original wait.
The renderer receives only bounded display facts and opaque handles, never paths,
commands, candidate digests, profiles, credentials or trust settings.

Validation uses small synthetic wire facts and real protected files/process locks:

```
npm test
python -m unittest discover -s tests/service_stop -v
npm run test:resident-package-hosts
```

Use the documented Node24 runtime on PATH for Python tests that exercise Node too.
The host test runs the real browser/Electron factories, guarded routes and shared UI;
its constructor-only qualification substitutes do not change production tables.
The controller loads lazily. Its panel adds bounded initial UI code; the initial
bundle error budget is680kB (previously675kB), with the400kB warning unchanged.
Actual native lifecycle/package eligibility and production enrollment remain separate.
