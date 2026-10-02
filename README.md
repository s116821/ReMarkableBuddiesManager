# ReMarkableBuddies Manager

One Angular UI for the browser and Electron desktop. This **foundation preview**
shows an unconfigured tablet connection. Installation, release discovery, updates,
configuration and data management are future REM-41/REM-42 work; no tablet is accessed.

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
```

On headless Linux, run `npm run check` and `npm run test:package` under `xvfb-run -a`.
Portable package checks support Windows x64 and Linux x64. macOS packaging,
signing/notarization and automatic desktop updating are not delivered here.
For release fixtures, follow the public [release guide](release/README.md):
Python 3.12, Node 24, GitVersion 6.8.2 and pinned upstream Action distributions.
All fixture tags/remotes are temporary and local. CI checks both supported hosts.

## Contribute and release

Use scoped semantic PR titles, such as `feat(REM-21): add Manager foundation`.
PR bodies contain only `# Summary` and concise bullets; put evidence in comments.
Git tags are the official application version authority; `package.json`'s 0.0.0
is only a tooling placeholder. Local/PR builds visibly carry a development suffix.
Official browser and desktop ZIPs are compiled after tagging exact source;
docs-only merges create no tag or application build. Major 1+ publication stays
blocked until the separately reviewed REM-35 release gate.

All requirements, active OpenSpec changes, archives and workflow skills live only
in [RemarkableBuddiesDocs](https://github.com/s116821/RemarkableBuddiesDocs).
This implementation belongs to central change `manager-foundation` and capability
[`manager-foundation`](https://github.com/s116821/RemarkableBuddiesDocs/tree/main/openspec/specs/manager-foundation).
Link coordinated Docs and code PRs with exact revisions; no duplicate spec tree here.

Build/package helpers are adapted from GPLv3 ReMarkableBuddies at
`33db26add721cea6c0121ad769a54d06ae600b4e`. This repository uses GPL-3.0-only;
see [LICENSE](LICENSE). Third-party packages retain their own licenses.

Releases use upstream Actions and GitVersion, independently of Rust. The `action-driven-releases` central change replaces the former Python coordinator; custom code only builds/packages/verifies application artifacts.

### REM-46 qualification remains open

GitVersion 6.8.2 does not yet pass the same-second ancestry regression in
`release/test_versioning_equal_dates.py`. In a linear baseline/feature/fix history
with equal commit timestamps, it calculates `0.2.0` for the fix instead of
`0.2.1`; after the later commit is tagged `v0.2.1`, an earlier detached feature
job calculates `0.2.2` instead of `0.2.0`. The actual Windows and Linux binaries
both reproduce this. The ordinary history fixture can pass when invocation time
separates commits; that is insufficient qualification. Keep this change in draft
until an upstream-owned remedy passes both fixtures and independent review.
No production tag, release, or native application qualification follows from
these isolated tests.
