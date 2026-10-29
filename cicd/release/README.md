# Ordered application releases

Canonical [release requirements](https://github.com/s116821/ReMarkableBuddiesDocs/blob/main/openspec/specs/release-versioning/spec.md)
remain central. CI runs Checks, Build, supported Windows/Linux artifact Integration,
then the one eligible main Release job. PRs cannot publish. Documentation-only
changes retain metadata checks without compilation or publication.

## Maintained tools and direct workflow steps

- dorny/paths-filter and semantic-pull-request classify paths and validate titles.
- Hash-locked Python Semantic Release selects candidates read-only and creates
  tags only after artifact integration. No source version, changelog/version
  commit or release-job rebuild exists; the separate pre-1.0 hold remains.
- npm development/production/package commands run explicitly in the workflow.
  Standard unzip and Windows Expand-Archive stage verified CI ZIPs.
- Exact GraphQL lookup and octokit request Actions manage the draft by ID.
- Pinned svenstaro/upload-release-action at
  `29e53e917877a24fad85510ded594ab3c9ca12de` uploads only missing assets by exact
  release ID, with overwrite false, duplicate checks on, draft true and promotion
  off. CI uses its upstream distributed Action directly. It does not rebuild,
  change dependencies or retest third-party Actions. The former selected-source
  recipe/audit and earlier failed alternatives remain historical evidence; no
  old audit or source-built bundle is claimed for this direct Action.

## Project-specific release checks

| File | Why it remains |
| -- | -- |
| admission.py | Refuse ambiguous/nonforward main ranges and require the exact canonical merged main PR. |
| freeze.py, semantic_source.py | Bind the maintained tool's candidate to clean exact source and eligible scoped subject; reject premature 1.0. No custom version calculation. |
| build.py, artifacts.py | Assemble fixed browser/Windows/Linux ZIPs with Linux executable modes and embedded build identity; verify exact inventory/provenance/digests. No command orchestration. |
| verify_release.py | Verify the same release ID, retained remote bytes and only-missing inventory around maintained publisher Actions. |

The pipeline passes immutable artifact IDs to integration and publication.
Integration stages and exercises those bytes without rebuilding. Candidate build
metadata embeds the frozen tag/source before tag creation; it is not publication
trust. Final annotated remote tag/source and complete verified release establish
publication eligibility. Local development metadata remains unofficial.

Use Actions **Re-run failed jobs** for interrupted final publication while tested
artifacts remain available (14 days). Retry checks the same tag/draft/assets,
uploads only missing bytes, refuses conflicts and verifies all bytes before
publication. Full reruns must pass every gate and cannot replace retained bytes.
The uploader's missing-ID fallback can create another draft; the independent
same-ID check refuses its publication. Native workflow serialization does not
control external writers or promise atomic platform immutability.

## Focused local checks

Install Python 3.12, supported Node 24.21 and the maintained tools:
`python -m pip install --require-hashes -r cicd/release/python-tools.lock`.
Run `npm run test:release`. Workflow controls use
`npm ci --prefix cicd/release/fixtures --ignore-scripts --no-audit --no-fund`
then `npm test --prefix cicd/release/fixtures`. They test project stage/event and
artifact gates rather than maintaining a downstream upstream-Action test suite.
No fixture publishes production tags, changes settings or operates a tablet.
