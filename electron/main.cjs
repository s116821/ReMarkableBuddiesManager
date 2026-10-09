const { app, BrowserWindow, session, shell } = require('electron');
const path = require('node:path');
const GUIDE = 'https://github.com/s116821/RemarkableBuddiesDocs';

app.setName('ReMarkableBuddies Manager');
if (process.env.MANAGER_TEST === '1' && process.env.MANAGER_TEST_PROFILE) app.setPath('userData', process.env.MANAGER_TEST_PROFILE);
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({
    width: 1200, height: 950, minWidth: 360, minHeight: 600,
    show: process.env.MANAGER_TEST !== '1', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === GUIDE) void shell.openExternal(GUIDE);
    return { action: 'deny' };
  });
  // Host tests install interception on a blank renderer before starting Angular.
  if (process.env.MANAGER_TEST === '1' && process.env.MANAGER_TEST_DEFER_LOAD === '1') {
    void window.loadURL('about:blank');
  } else {
    void window.loadFile(path.join(__dirname, '../dist/manager/browser/index.html'));
  }
});
app.on('window-all-closed', () => app.quit());
