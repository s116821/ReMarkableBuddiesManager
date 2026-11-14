const {app, BrowserWindow, ipcMain, session} = require('electron');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const profile = process.env.MANAGER_TEST_PROFILE;
if (!profile) throw Error('Fixture profile is required');
app.setPath('userData', profile);
app.whenReady().then(async () => {
  const root = path.join(__dirname, '../..');
  const {backupPreferencesFixture} = await import('./isolated-backup-preferences.mjs');
  const {IsolatedBackupPreferences, isManagerMainFrame, watchBackupDocument,
    registerIsolatedBackupHandler, registerPortableConfigurationHandler} =
    await import('../../host/isolated-backup-preferences.mjs');
  const {MemoryForgetHost} = await import('../../host/memory-forget.mjs');
  const fixture = await backupPreferencesFixture(app.getPath('userData'));
  const {composition, observer, target} = fixture;
  const {driveAuth, isolatedBackup} = composition;
  const {portable, io} = target.f;
  const wrapped = new MemoryForgetHost({observer, io, beforeIO: () => portable.invalidate()}).wrap();
  const preferences = new IsolatedBackupPreferences({composition, isolatedBackup, portable, observer});
  const ui = path.join(root, 'dist/manager/browser/index.html');
  const uiUrl = pathToFileURL(ui).href;
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({show: false, webPreferences: {
    preload: path.join(root, 'electron/preload.cjs'), sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true,
  }});
  const authorized = (event, args) => args.length === 0 && isManagerMainFrame(event, window, uiUrl, closing);
  let closing, drained = false;
  const document = watchBackupDocument(window, original => {
    void preferences.invalidate(original);
    wrapped.cancel();
    isolatedBackup.invalidate();
  });
  registerIsolatedBackupHandler(ipcMain, authorized, document, preferences);
  registerPortableConfigurationHandler(ipcMain, authorized, portable);
  for (const action of ['observe', 'cancel']) {
    ipcMain.handle('manager:' + action, (event, ...args) => {
      if (!authorized(event, args)) throw Error('Fixture observation caller refused');
      return wrapped[action]();
    });
  }
  ipcMain.handle('manager:drive:status', (event, ...args) => {
    if (!authorized(event, args)) throw Error('Fixture Drive caller refused');
    return driveAuth.status();
  });
  globalThis.backupPreferencesFixture = {
    snapshot: fixture.snapshot,
    setNoChange: value => { target.f.portableState.noop = value; },
    load: () => window.loadFile(ui),
  };
  app.on('before-quit', event => {
    if (drained) return;
    event.preventDefault();
    closing ??= preferences.dispose().then(() => fixture.close()).then(() => {
      drained = true;
      app.quit();
    }, () => app.exit(1));
  });
  await window.loadURL('about:blank');
  window.show();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
