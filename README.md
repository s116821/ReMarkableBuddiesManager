# ReMarkableBuddies Manager

One Angular UI for the browser and Electron desktop. This **foundation preview**
offers explicitly configured Linux USB/SSH read-only tablet observation and
official stable release discovery with a saved source preference. Installation, qualified update offers,
configuration and data management remain REM-41/REM-42 work.
See [wired observation setup and limits](docs/wired-observation.md).
See [release-source preview and Tailwind conventions](docs/release-source.md).
Developers can separately run [offline Vellum apk qualification](docs/vellum-verification.md).
Its synthetic host evidence does not enable installation or qualify a tablet.

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
For release fixtures, install Python 3.12 and git-cliff 2.14.2, run
`npm ci --prefix release`, then `npm run test:release`.
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
The foundation belongs to central capability `manager-foundation`; wired observation
is coordinated through active central change `manager-wired-observation` and capability
[`manager-foundation`](https://github.com/s116821/RemarkableBuddiesDocs/tree/main/openspec/specs/manager-foundation).
Link coordinated Docs and code PRs with exact revisions; no duplicate spec tree here.

Release machinery is adapted from GPLv3 ReMarkableBuddies at
`33db26add721cea6c0121ad769a54d06ae600b4e`. This repository uses GPL-3.0-only;
see [LICENSE](LICENSE). Third-party packages retain their own licenses.
