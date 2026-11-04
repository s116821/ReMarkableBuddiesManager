# Prepare Buddy storage

Both the browser companion and Electron Manager offer **Review storage setup**
after a verified wired tablet observation. Review explains the operation and
performs no tablet command. It does not check whether storage is empty, freeze
configuration, reserve changes, or predict repairs. The review expires after
120 seconds and is invalidated by another maintenance action or a session change.

Choose **Prepare storage** separately to run Buddy's existing fixed
`--sync-mode-operation initialize` operation once. Buddy must already be installed
at its supported location, with valid configured roots and legacy sync disabled.
Manager does not edit those prerequisites. Initialization uses normal configured
`Store::open` creation and recovery, which can clean up Buddy-owned staging.
It preserves the saved mode. It does not install Buddy, choose Local-only, change
paths, restore an archive, stop a service, activate native pages, or contact a
cloud provider.

**Buddy storage prepared** means the live host admitted the complete original
successful initialization report. Only the current saved-mode kind is displayed.
This does not establish empty/new storage, independent flush or power-loss
durability, current runtime adoption, provider readiness, or replacement-device
restore compatibility.

If a command might have started but its result cannot be admitted, Manager keeps
**Storage setup not confirmed**. A refusal, unsupported response, cancellation,
timeout or lost response after possible dispatch does not prove that no storage
changed. Manager never retries setup automatically. **Check current storage**
runs only the separate fixed inspection; it may show the current saved-mode kind,
but cannot settle the earlier setup. Stop stops waiting and targets the captured
setup/check invocation; it cannot undo remote effects.

Unconfirmed initialization blocks another initialization for the same verified
connection identity within the current host lifetime, even after the tablet
reboots. Executing an original confirmation or current check additionally requires
the original boot identity. Other maintenance actions remain available and keep
that history. Up to eight possible-dispatch attempts are retained without eviction,
with up to 32 invocation/cancellation fences per attempt. Capacity refuses further
work rather than discarding earlier uncertainty. Host history is in memory only:
restarting Manager/helper neither reconstructs nor confirms an earlier result.
A captured original success may remain historical prepared if only its later
public delivery was lost; a subsequent inspection cannot supply that evidence.

## Manual equivalent and development checks

An authorized manual workflow can invoke the same fixed command with no stdin:

```sh
/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json /opt/bin/reader-buddy --sync-mode-operation initialize
```

Replace only the final selector with `inspect` for the separate current read.
Review the configured roots and normal recovery semantics before a deliberate
initialization.

Public calls accept identity, action, a host-issued reference and invocation fence
only. They accept no command, path, configuration, token, account or mode. Raw
snapshot identities and receipts never enter the renderer. Limits are 512-byte
requests, 16-KiB raw report, 24-KiB private child envelope and 8-KiB public response;
channel/collection/child/host/UI budgets are 2/8/12/13/14 seconds. UI time includes
observation quiescence, and stopped/expired queued work cannot dispatch later.

Run `npm test`, `python -m unittest discover -s tests/storage_initialization -v`,
and `npm run test:storage-initialization-hosts` after the documented builds.
Run the host command with `-- --packaged` after packaging. Headless Linux needs
an isolated X display. Tests use synthetic reports and a local test SSH peer;
they do not establish physical USB, tablet filesystem or provider qualification.
