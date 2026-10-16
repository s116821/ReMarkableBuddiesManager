# Manager's own release preview

The shared browser/Electron panel shows the current compiled Manager build and
Manager's latest official stable candidate separately from Buddy. Both repositories
refresh independently on startup, explicit refresh and the existing five-minute
poll. A failure/backoff in one does not block the other. Buddy's saved source
preference stays Buddy-only; Manager always queries its fixed official repository.

Current build identity comes from existing generated Git/build metadata. No project
version is maintained or bumped by this feature. Development builds are identified
as such; a latest stable tag does not prove they are older/newer. The existing
source-placeholder policy gap remains separately tracked by the release owner.

A candidate must be a clean stable tag from the correct repository with no draft or
prerelease flag. Manager's published-file metadata requires manager-browser.zip,
manager-linux-x64.zip, manager-win32-x64.zip and provenance.json. Uploaded size/URL
metadata alone is not checksum/signature/source/provenance verification, qualified
compatibility or a completed update. Incomplete, missing, stale and failed states
remain explicit. This slice offers no download, automatic update or tablet mutation.

Both applications update independently; equal versions are not a compatibility
contract. Browser deployment/reload, desktop updating, signed package validation,
rollback and full REM-41/35 delivery remain separate work.

Run the normal README checks and package checks. Two new Node controls validate
repository/asset identity and independent preference/backoff/refresh. Actual browser
and Electron fixtures intercept both fixed APIs before startup, deny unexpected
traffic, exercise stable candidate changes without reload and separate failure.
No actual release/provider/tablet request is needed for fixtures. Screenshots and
host results belong in exact-revision PR comments; interpreted metadata never grants
native or installation authority.

Central change: manager-self-release-discovery in ReMarkableBuddiesDocs. Earlier
transport/inspector parents remain explicitly unmerged and physically unqualified
where documented. No new dependency/release framework or version field is added.
