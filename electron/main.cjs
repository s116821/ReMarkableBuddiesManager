const { app, BrowserWindow, session, shell, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const GUIDE = 'https://github.com/s116821/RemarkableBuddiesDocs';

app.setName('ReMarkableBuddies Manager');
if (process.env.MANAGER_TEST === '1' && process.env.MANAGER_TEST_PROFILE) app.setPath('userData', process.env.MANAGER_TEST_PROFILE);
app.whenReady().then(async () => {
  const hostRoot = app.isPackaged ? path.join(process.resourcesPath, 'host') : path.join(__dirname, '../host');
  const { WiredObserver } = await import(pathToFileURL(path.join(hostRoot, 'observer.mjs')).href);
  const observer = new WiredObserver({ script: path.join(hostRoot, 'wired_observer.py') });
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
  for (const action of ['observe', 'cancel']) ipcMain.handle(`manager:${action}`, (event, ...args) => {
    if (!authorized(event, args)) throw new Error('Observation caller refused');
    return observer[action]();
  });
  window.on('closed', () => observer.cancel());
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
