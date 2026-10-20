# Inspect saved configuration

Both the browser/helper and Electron share an explicit **Inspect saved configuration**
action after a wired tablet observation. The view shows supported settings as saved
values or privacy-preserving presence summaries, with **Default**, **Declared** or
**Explicit null** origin. It never claims effective runtime/environment settings,
provider authentication, active memory mode, a reloaded service or safe storage roots.
An omitted optional field and explicit null can have the same safe value but remain
distinct origins. No background settings read is added.

Only 25 allowlisted scalar/presence fields are displayed. Model, endpoint, credential
reference, paths, memory profile/selection and sync collection details are withheld.
Personalization shows enabled/text-present/UTF8 byte length, without contents or a
text digest. Use its separate existing editor for that deliberate action. A path
setting being present never establishes that a directory exists, is safe or is owned.
The three path fields inherit one common origin because a declared paths object
requires all three members. Namespace strings are unique and lexically sorted.
Unsupported Reader/Writer enablement, retrieval/research policy, Mem destination and
handwriting settings are explicit schema gaps, not invented false/default values.

The published default media limit is 33554432 bytes; the existing supported maximum
is 268435456 bytes (256 MiB). Values are exact safe integers; malformed origins,
nullability, ranges and pure memory/sync consistency refuse the complete view. No
partial field list or fallback defaults hide a refused or unsupported report.

## Lifetime and shared host

Inspection pauses ordinary polling and checks the original connection/boot and
observation generation. Cancel, same-ID tablet refresh, document navigation,
disconnect or a new host operation prevents a late result from restoring old fields.
Cancellation shares the existing connection queue so an old cancel cannot kill a
later read. The view is not persisted and does not promise the saved file remains
current after the producer read it. Reinspect deliberately when needed.

The configuration action invalidates a prepared forget reference in the privileged
shared host BEFORE inspection I/O. Renderer clearing alone is insufficient. A
possibly dispatched forget stays unknown with its original private bytes retained;
this read never settles, replaces or retries that mutation. Main-document navigation
also cancels the local wait. Resource requests and subframes, even at the same URL,
are not main-document navigation and do not invalidate it. Cancellation is not proof
that a remote operation rolled back.

## Fixed manual interface and bounds

The [exact producer contract](https://github.com/s116821/ReMarkableBuddiesDocs/blob/2a320181739e0d598ed830d31329214e036df646/openspec/changes/inspect-saved-configuration/contract.md)
selects one explicit configuration with the existing environment variable:

```sh
REMARKABLE_BUDDIES_CONFIG=/absolute/owned/config.json reader-buddy --configuration-operation inspect
```

There is no `--config` or `--configuration-input` flag and no command stdin. The
producer only reads the admitted bounded configuration file and its admission
metadata. It uses pure typed-value validation, does not probe declared roots, read
provider credentials, resolve environment overrides, open/recover a Store, initialize
or write settings, start a worker/service/device, or contact a provider. A missing
explicit file is unavailable; it never falls back to another config or default file.
Old binaries can reject the selector; that is unsupported, not an empty successful
snapshot. Equal app versions never prove installed capability.

Manager retains its fixed clean environment/config/Reader path and existing protected
Linux/Windows wired callbacks. The public helper/IPC request is only connection and
boot identity; callers cannot choose paths, commands, fields, stdin or a digest.
Python child identity stdin is private transport input, separate from the no-stdin
remote command. The raw whole-file digest stays private, is dropped during reduction
and grants no future write/CAS/runtime authority. Both bridges and controller reject
raw reports, private fields and unknown schemas rather than displaying them.

Caps: request256 bytes, raw report131072 including LF, discarded stderr8192, private
child envelope139264 and public result32768. One complete zero-exit UTF8 JSON line
with no duplicates/trailing material is required. Channel/collector/Python/Node/browser
deadlines remain2/8/12/13/14 seconds, below the producer's at-most30-second ceiling.
No shared timeout was lengthened; no automatic retry, SFTP or staging fallback was introduced.

## Checks and evidence

Run `node --test tests/saved-configuration*.test.mjs`,
`python -m unittest discover -s tests/saved_configuration -v`, and
`npm run test:saved-configuration-hosts` (add `-- --packaged` for retained packages).
Use the usual documented runtime/Playwright/headless dependencies. Actual local SSH
peer controls use deterministic public test identities and synthetic route/notice
data. UI controls keep actual helper/session/IPC/frame/generation guards, replacing
only lower transport with original attributed reports or explicit synthetic faults.

`tests/fixtures/saved-configuration-4bc7eb0-corpus.json` is copied byte-identically
from [the producer artifact](https://github.com/s116821/ReMarkableBuddies/blob/0e0eec73e5579d6f160789fd0e3c0da8e7dbde8a/tests/fixtures/saved-configuration-4bc7eb0-corpus.json).
All 35 actual Windows CLI reports verify all 70 original input/stdout hashes; exact
padding/base64 input recipes preserve cap and invalid-UTF8 cases. Capture source is
4bc7eb0c6bf55af8392ee36a8eb3a7ca400a5389 and the retained capture-time executable
SHA256 is 281fb6ea67c4028fae95a9c657e7058a0a1037c2d726bf2c4ced31bdba77d211.
Reports pass the strict actual consumer parser/controller, including exact origins,
privacy sentinels, lexical namespaces, refusal and unsupported cases. Producer cases
were not replayed for transfer. The pinned `{}` example remains a synthetic design
vector, not a replacement for these original CLI specimens. No physical USB,
installation, provider, effective-runtime or native-page qualification follows.
