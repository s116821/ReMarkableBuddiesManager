# Google Drive sign-in on the Manager host

Owning central change: `manager-drive-auth` in ReMarkableBuddiesDocs. This is
explicit sign-in/credential lifecycle on the computer running the local helper
or Electron. It works without a connected tablet. Cloud backup browsing and
publication, replacement-device restore, group selection and tablet
credential/configuration installation remain separate unfinished contracts.
Signing in does not enable them. Ordinary local archive restore is a separate
flow described in [the restore guide](ordinary-restore.md).

Use supported Node24.21, Python3.12, and the existing Windows host requirements
(pinned pywin32312) when running on Windows. The static browser uses the explicit
local helper; an arbitrary deployed website cannot reach private computer files.
Tokens stay on that host and do not enter browser localStorage or renderer IPC.
Custody uses protected files, not a promise of whole-disk encryption. On Windows,
current-user ownership and a protected DACL must exclude broad users/groups;
SYSTEM/Administrators retain the existing host-security allowance.

## Configure a desktop registration

A deployment operator must configure a real Google **Desktop app** OAuth client
from the [Google installed-app guide](https://developers.google.com/identity/protocols/oauth2/native-app),
with Drive API enabled and applicable consent/test-user settings. No live client
is provisioned or embedded by this repository. The native app uses the system
browser and dynamic127.0.0.1 loopback redirect, S256 PKCE and fresh state. Do not
configure a web/mobile client, embedded login, arbitrary endpoint or custom scope.
Main must coordinate the same intended Google app/account binding for future
appDataFolder backup access; a client ID alone is not authority over an unrelated
backup namespace.

Set absolute `MANAGER_DRIVE_AUTH_ROOT` and `MANAGER_DRIVE_PYTHON` before starting
the helper or Electron. `MANAGER_WIRED_PYTHON` is an interpreter fallback only;
SSH credentials remain separate. Default root is `ReMarkableBuddiesManager/drive-auth`
beneath Linux XDG config/home `.config`, or Windows LOCALAPPDATA.

Create a **new private** root directory (Linux0700/current owner; Windows current
owner/protected DACL). Do not take ownership or change permissions of a shared
folder. Place fixed `client.json` there (Linux0600/Windows protected owner-only
file) with the following exact fields; replace the placeholder locally:

```json
{"schema":1,"type":"google-desktop","clientId":"YOUR_DESKTOP_CLIENT_ID.apps.googleusercontent.com","clientSecret":null}
```

Use the downloaded desktop client secret when Google provides one. Preserve its
exact value; accidental whitespace/control characters refuse instead of being
silently trimmed. A trailing newline outside the JSON object is harmless.
Do not commit the registration/secret/grant or paste them into issue comments.
Public configuration and manual helper/Electron startup need no private plugin.
The existing Windows fixture demonstrates owner/security-descriptor stamping at
creation, without takeover/elevation. Unsupported or unprotected setup reports
unavailable and does not fall back to insecure credentials.

## User actions and observed state

Start the normal Electron app or `npm run wired:browser`. Sign in explicitly.
Electron opens the host-minted Google consent URL in the system browser; browser
users click the displayed Continue link. No credentials are entered in the
Manager. A successful callback must match its one-time state/current flow, then
actual token-info audience/scopes/expiry and Drive
[about.user identity](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get)
are checked before persistence. Only drive.appdata is requested. Provider refusal,
expiry, malformed/wrong-state callbacks and unavailable custody leave the prior
grant intact. Account labels are displayed as text, never HTML/prompt content.

A restart displays **saved/cached** account details, not a fresh provider check.
Check connection explicitly validates scope/client/account, refreshes expired
credentials with the maintained library and persists only verified results.
Saved host schema uses token expiry milliseconds; it is not a ready Rust/tablet
credential file and intentionally contains no fabricated collection/group ID.

Cancel invalidates pending requests and closes the callback listener. Immediately
before saving, the live generation is checked, then a bounded synchronous protected
CAS/atomic commit runs with no intervening host event. Cancellation after actual
commit does not revoke/remove a completed grant. A timed-out/unknown child receipt
is unavailable, not proof that no write occurred; fresh custody readback is required.
A cooperative cross-instance lock plus original client/grant digests rejects changed
records. No hostile same-user writer or power-loss durability guarantee is claimed.
An interrupted save may leave a private operation lock/stage; inspect the known
host operation before manually recovering only those files. No automatic permission
widening, broad deletion or repair runs.

Disconnect this Manager removes only its protected local grant. Remove Google
access is a separately confirmed provider revocation that can affect other copies
of the configured Google app; backup files and tablet credentials are not deleted.
The confirmation includes a host-issued opaque snapshot ID; changed client/grant
refuses before provider traffic. Provider failures or post-request custody drift
report removal unconfirmed; they are not converted to success or retried silently.

## Boundaries and checks

Fixed authenticated helper `/manager-drive` POST actions retain exact origin/Host,
HttpOnly session, canonical192byte body and action shape. Only revocation carries
one64hex host-issued confirmation ID. The prior `/manager-host`64byte body/commands
are unchanged. Electron permits only the configured UI main frame; it never accepts
client/path/token/endpoint/command or arbitrary external URL parameters. Callback
is a separate ephemeral localhost listener: bounded GET/path/Host, unique recognized
query members, one-time timing-safe state,8192byte URL and five-minute TTL.

Every maintained-library request forces15seconds/64KiB response/no retries/no
redirects; callback token→token-info→about and explicit check are bounded. Explicit
provider endpoints are fixed. Trusted constructor-only localhost endpoints are
used solely by owned protocol tests. The fixed-file Python child has3seconds and
64KiB output, takes secrets via stdin and emits sanitized failures without stderr.
Raw callback/transport diagnostics, tokens, verifier and source paths are not
exported to UI/status or evidence. The dependency's default auth request/response
logging interceptors are disabled through its supported constructor option.

```text
npm test
python -m unittest discover -s tests/drive -v
npm run check
npm run package
npm run test:package
npm run test:drive-hosts
npm run test:drive-hosts -- --packaged
npm audit --audit-level=high
```

Headless Linux uses the documented xvfb wrapper. The protocol suite uses actual
maintained OAuth client calls against owned loopback HTTP fixtures; Linux custody
uses real private files. Windows protocol tests explicitly use memory custody;
separate Python tests exercise real NTFS owner/ACL/atomic behavior. Shared actual
browser/Electron/package renderer checks use explicitly synthetic status/IPC
responses, not live Google consent or filesystem proof. Packaged missing-config
refusal loads the actual bundled host client and fixed Python helper first.
A separately selectable actual bundled-host protocol run uses
`MANAGER_DRIVE_BUNDLE=out/host/drive-auth.mjs` with the same test file.

The pinned Google library is bundled with maintained esbuild only into the Node
host runtime. Matching upstream LICENSE/NOTICE files are preserved; an npm package
carrying its full MIT grant in README retains that exact README. Unknown missing
grants fail packaging. Its npm audit and tests do not qualify compiler/source
attestation, production OAuth registration, live provider/account behavior, backup
concurrency/domain schemas, native or full REM42 acceptance. Prior Manager physical
Windows and Main Rust backend delivery gates remain separate.
