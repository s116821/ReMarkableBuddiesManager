# ReMarkableBuddies Manager

One Angular UI for the browser and Electron desktop. This **foundation preview**
offers explicitly configured Linux USB/SSH read-only tablet observation and
official stable release discovery with a saved source preference. Installation, qualified update offers,
configuration and data management remain REM-41/REM-42 work.
See [wired observation setup and limits](docs/wired-observation.md).
See [release-source preview](docs/release-source.md) and [shared Tailwind conventions](docs/styling.md).
Google Drive [host sign-in setup and limits](docs/drive-auth.md) are independent of the tablet connection.
Developers can separately run [offline Vellum apk qualification](docs/vellum-verification.md).
Its synthetic host evidence does not enable installation or qualify a tablet.
The separate [original signed test-fixture observer](docs/signed-fixture-verification.md)
checks actual historical Buddy APKs offline with an independently pinned public key.
The separate [manual release quarantine command](docs/release-quarantine.md)
verifies original legacy Buddy download bytes; matching checksums do not enable installation.
The [manual Manager bundle verifier](docs/manager-bundle-verification.md) additionally
checks the current browser/desktop ZIPs' bounded embedded release identity.

Start with the public [ecosystem Docs hub](https://github.com/s116821/RemarkableBuddiesDocs)
and [Manager foundation guide](https://github.com/s116821/RemarkableBuddiesDocs/blob/main/docs/manager-foundation.md).
The tablet application is [ReMarkableBuddies](https://github.com/s116821/ReMarkableBuddies).
Manager and Rust have independent [release streams](https://github.com/s116821/RemarkableBuddiesManager/releases).

## Develop

Use Node **24.21.0** (see `.node-version`) and Git. No private account, agent or tablet is needed.

```sh
npm ci
npm start
```

Open the local URL printed by Angular. For desktop, use `npm run desktop`.
The browser production output is `dist/manager/browser`; serve it from a static
server, including a subdirectory. No hosting service or deployment is configured.

## Verify

```sh
npx playwright install --with-deps chromium
npm run check
npm run package
npm run test:package
npm run test:wired-hosts
npm run test:wired-hosts -- --packaged
```

On headless Linux, run `npm run check` and `npm run test:package` under `xvfb-run -a`.
Portable package checks support Windows x64 and Linux x64. macOS packaging,
signing/notarization and automatic desktop updating are not delivered here.
For release fixtures, install Python 3.12 and the hash-locked maintained tools with
`python -m pip install --require-hashes -r release/python-tools.lock`, then run
`npm run test:release`. See [release tooling](release/README.md) for Action controls.
All fixture tags/remotes are temporary and local. CI checks both supported hosts.

## Contribute and release

Use scoped semantic PR titles, such as `feat(REM-21): add Manager foundation`.
PR bodies contain only `# Summary` and concise bullets; put evidence in comments.
Git history supplies the application version; no own package.json version is
maintained. Ordinary developer builds remain visibly unofficial. Controlled CI
candidates embed a frozen future tag/version but do not establish publication
trust. The ordered pipeline is checks -> build -> integration of downloaded
browser/native packages -> one final main release job. Only after these gates
pass are the official remote tag and release created from those same bytes.
Docs-only changes remain noncompiling. Ambiguous main batch/initial history
refuses; exact associated-PR identity admits squash merges and excludes direct
push publication. Failed sources are not backfilled by later successes.

Use Actions Re-run failed jobs for retained-artifact/same-ID draft recovery.
See [release tools and evidence limits](release/README.md). Major 1+ publication,
native behavior and unmerged consumer-parent reconciliation remain separate gates.

All requirements, active OpenSpec changes, archives and workflow skills live only
in [RemarkableBuddiesDocs](https://github.com/s116821/RemarkableBuddiesDocs).
Canonical [foundation](https://github.com/s116821/RemarkableBuddiesDocs/tree/main/openspec/specs/manager-foundation)
and [wired observation](https://github.com/s116821/RemarkableBuddiesDocs/tree/main/openspec/specs/manager-wired-observation)
contracts describe these completed bounded capabilities.
Link coordinated Docs and code PRs with exact revisions; no duplicate spec tree here.

Release machinery is adapted from GPLv3 ReMarkableBuddies at
`33db26add721cea6c0121ad769a54d06ae600b4e`. This repository uses GPL-3.0-only;
see [LICENSE](LICENSE). Third-party packages retain their own licenses.

Manager verified download setup and limits: [download guide](docs/manager-downloads.md).

Personalization inspect/edit/save/disable/clear and saved-versus-active limits: [editor guide](docs/personalization.md).

Self-reported binary version and unknown running/package authority: [identity guide](docs/runtime-identity.md).

## Global subject-memory search

Both companions can explicitly query the connected tablet’s configured global subject memory through the supported one-shot stdin interface. See [usage, compatibility and evidence limits](docs/memory-search.md); older installed Readers remain unsupported and no edit/forget or service-control action is added.

Saved storage mode inspection and its saved-versus-active limits: [inspection guide](docs/saved-storage-mode.md).

Current revisions of a fact deliberately selected from search: [single-fact inspection](docs/memory-inspection.md).

Explicit prepared confirmation and historical receipt recovery: [forget one memory fact](docs/memory-forget.md).

Saved-only settings and safe origin summaries: [configuration inspection](docs/saved-configuration.md).

Saved basic settings can be deliberately edited in both companions; see the
[basic-settings guide](docs/basic-settings.md) for supported fields, private
conditions, uncertain outcomes and the fixed manual equivalent.

Saved model and endpoint declarations can also be deliberately replaced/cleared
from both companions. The [private model editor guide](docs/model-settings.md)
explains origin-only reads, exact replacement text and hash-only recovery.

Saved memory enabled/profile declarations use the shared [saved-memory editor](docs/memory-settings.md), with private profile input and runtime activation always unverified.

See [on-tablet ordinary archive export](docs/ordinary-archive-export.md) for private destination handling, explicit confirmation and manual equivalents. Off-device transfer and restore remain separate.

See [saved research-policy editing](docs/research-settings.md) for the separate saved-only policy interface and verification boundaries.
