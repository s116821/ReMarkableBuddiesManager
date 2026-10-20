const { app, BrowserWindow, session, shell, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const GUIDE = 'https://github.com/s116821/RemarkableBuddiesDocs';

app.setName('ReMarkableBuddies Manager');
if (process.env.MANAGER_TEST === '1' && process.env.MANAGER_TEST_PROFILE) app.setPath('userData', process.env.MANAGER_TEST_PROFILE);
app.whenReady().then(async () => {
  const hostRoot = app.isPackaged ? path.join(process.resourcesPath, 'host') : path.join(__dirname, '../host');
  const { WiredObserver, validateResult } = await import(pathToFileURL(path.join(hostRoot, 'observer.mjs')).href);
  const { parseMemoryInspectionRequest, parseMemoryInspectionResult } = await import(pathToFileURL(path.join(hostRoot, 'memory-inspection.mjs')).href);
  const { parseSavedModeRequest, parseSavedModeResult } = await import(pathToFileURL(path.join(hostRoot, 'saved-mode.mjs')).href);
  const { MemoryForgetHost } = await import(pathToFileURL(path.join(hostRoot, 'memory-forget.mjs')).href);
  const { parseForgetRequest, parseForgetResult } = await import(pathToFileURL(path.join(hostRoot, 'memory-forget-protocol.mjs')).href);
  const rawObserver = new WiredObserver({ script: path.join(hostRoot, 'wired_observer.py') });
  const forget = new MemoryForgetHost({ observer: rawObserver });
  const observer = forget.wrap();
  const { DriveAuth } = await import(pathToFileURL(path.join(hostRoot, 'drive-auth.mjs')).href);
  const driveAuth = new DriveAuth();
  const { ManagerDownloads } = await import(pathToFileURL(path.join(hostRoot, 'manager-downloads.mjs')).href);
  const downloads = new ManagerDownloads();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({
    width: 1200, height: 950, minWidth: 360, minHeight: 600,
    show: process.env.MANAGER_TEST !== '1', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  const ui = path.join(__dirname, '../dist/manager/browser/index.html');
  const authorized = (event, args) => args.length === 0 && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === pathToFileURL(ui).href;
  for (const action of ['observe', 'cancel', 'inspectOwned', 'inspectRuntime']) ipcMain.handle(`manager:${action}`, (event, ...args) => {
    if (!authorized(event, args)) throw new Error('Observation caller refused');
    return observer[action]();
  });
  ipcMain.handle('manager:download', (event, ...args) => {
    if (!authorized(event, []) || args.length !== 1) throw new Error('Download caller refused');
    return downloads.request(args[0]);
  });
  ipcMain.handle('manager:memoryQuery', (event, ...args) => {
    if (!authorized(event, []) || args.length !== 1) throw new Error('Memory query caller refused');
    return observer.memoryQuery(args[0]);
  });
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if(mainFrame) forget.invalidate(); });
  ipcMain.handle('manager:memoryForget', async (event, ...args) => {
    if (!authorized(event, []) || args.length !== 1) throw Error('Memory forget caller refused');
    const request = parseForgetRequest(args[0]);
    const value = await parseForgetResult(await forget.request(request), validateResult);
    return forget.assertCurrent(value);
  });
  ipcMain.handle('manager:inspectMemory', async (event, ...args) => {
    if (!authorized(event, []) || args.length !== 1) throw new Error('Memory inspection caller refused');
    const request = parseMemoryInspectionRequest(args[0]);
    return parseMemoryInspectionResult(await observer.inspectMemory(request), request, validateResult);
  });
  ipcMain.handle('manager:inspectSavedMode', async (event, ...args) => {
    if (!authorized(event, []) || args.length !== 1) throw new Error('Saved mode caller refused');
    const request = parseSavedModeRequest(args[0]);
    return parseSavedModeResult(await observer.inspectSavedMode(request), request, validateResult);
  });
  ipcMain.handle('manager:personalization', (event, ...args) => {
    if (!authorized(event, []) || args.length !== 1) throw new Error('Personalization caller refused');
    return observer.personalization(args[0]);
  });
  for (const action of ['status', 'begin', 'cancel', 'check', 'disconnect', 'revoke']) ipcMain.handle(`manager:drive:${action}`, async (event, ...args) => {
    const allowed = action === 'revoke' ? args.length === 1 && typeof args[0] === 'string' && /^[a-f0-9]{64}$/.test(args[0]) : args.length === 0;
    if (!allowed || !authorized(event, [])) throw new Error('Drive caller refused');
    if (action !== 'begin') return action === 'revoke' ? driveAuth.revoke(args[0]) : driveAuth[action]();
    const result = await driveAuth.begin();
    if (result.authorizationUrl && driveAuth.ownsAuthorizationUrl(result.authorizationUrl)) {
      if (process.env.MANAGER_TEST !== '1') {
        try { await shell.openExternal(result.authorizationUrl); }
        catch { driveAuth.cancel(); return { state: driveAuth.state, authorizationUrl: null }; }
      }
    }
    return { state: result.state, authorizationUrl: null };
  });
  window.on('closed', () => { observer.cancel(); driveAuth.dispose(); downloads.dispose(); });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === GUIDE) void shell.openExternal(GUIDE);
    return { action: 'deny' };
  });
  // Match the reviewed host-fixture seam: no Angular load until interception is ready.
  if (process.env.MANAGER_TEST === '1' && process.env.MANAGER_TEST_DEFER_LOAD === '1') {
    void window.loadURL('about:blank');
  } else {
    void window.loadFile(ui);
  }
});
app.on('window-all-closed', () => app.quit());
