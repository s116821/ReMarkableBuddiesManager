# Reader, Writer and export settings

Read tablet state, then use **Begin product settings edit** in the **Reader,
Writer and export** panel. The installed Buddy must support the dedicated
product-settings editor. An older Buddy may report unsupported or unavailable;
the Manager does not guess support from the older general configuration view.

Reader and Writer default to enabled; the export backend defaults to Mem.
**Default** means no saved override. Choosing Enabled or Mem explicitly declares
that value. **Remove override** restores the default for only that field. Keep
other controls untouched to preserve them. Save submits those deliberate changes
once against the revision inspected at Begin. A stale revision requires a fresh
edit; no automatic retry or refreshed-base write occurs.

**Saved file verified — restart required** confirms saved readback only. It does
not restart Buddy or verify the running roles, credentials, provider or tablet.
Reader disabled stops ordinary Reader startup; Writer disabled refuses new Writer
work. Disabling export still permits Writer drafts when Writer is enabled.
Settings maintenance can re-enable either role without model or Mem credentials.
Existing uncertain export reconciliation is limited to its recorded original;
these controls do not delete records or third-party notes. Automatic Reader to
Writer delegation and full account/workspace/collection setup remain separate.

If a Save becomes **unknown**, keep its original retained row and explicitly
check its desired file. A later **desired saved file observed** cannot identify
who published it or establish running activation. Stop cancels the local wait;
it cannot roll back a possibly dispatched save. Canceling a ready editor
permanently revokes that reference. Begin again for any new edit.

Ready editors expire after two minutes. The host retains at most eight uncertain
originals. Private status custody expires thirty minutes after possible apply,
without renewal, and permits at most32 executing checks per original. Expired
safe diagnostic rows remain and do not create retry authority. Reloading the UI
can display host-retained diagnostics; losing/restarting the host loses private
custody, so a new host cannot reconstruct or replay that save.

The browser helper and sandboxed Electron app use the same typed capability and
maintenance queue. Paths, hashes, configuration bytes, operation IDs and intents
remain host-private. The UI offers no credential, endpoint or account editor here.

## Local verification

Use the repository Node version and existing dependency installation:

```sh
npm test
python3 -m unittest discover -s tests/product_settings -v
npm run build:development
npm run build
npm run test:product-settings-hosts
npm run test:product-maintenance-hosts
npm run test:product-lifetime-hosts
npm run package
npm run test:product-settings-hosts -- --packaged
npm run test:product-maintenance-hosts -- --packaged
npm run test:product-lifetime-hosts -- --packaged
```

The host tests isolate external services and use synthetic lower-layer reports;
Python tests use mock channels and local subprocesses, without an SSH connection.
The central reference corpus has129 definitions:19 whole-file producer fixtures,
60 raw frames,19 public requests,17 public results and14 lifecycle expectations.
The consumer executes the96 raw/public cases; that does not execute the storage
fixtures or convert the lifecycle catalog into tests. Actual producer capture
replay, hosted Windows/Linux checks and device qualification must be attributed
separately.

The initial bundle error budget is625kB for the additional panel and validation;
the400kB warning remains. The first measured implementation was595.90kB raw,
103.06kB estimated transfer. This budget remains a bounded build check.
