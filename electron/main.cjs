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
  const { parseSavedConfigurationRequest, parseSavedConfigurationResult } = await import(pathToFileURL(path.join(hostRoot, 'saved-configuration.mjs')).href);
  const { parseSavedModeRequest, parseSavedModeResult } = await import(pathToFileURL(path.join(hostRoot, 'saved-mode.mjs')).href);
  const { MemoryForgetHost } = await import(pathToFileURL(path.join(hostRoot, 'memory-forget.mjs')).href);
  const { parseForgetRequest, parseForgetResult } = await import(pathToFileURL(path.join(hostRoot, 'memory-forget-protocol.mjs')).href);
  const {OrdinaryExportHost}=await import(pathToFileURL(path.join(hostRoot,'ordinary-export.mjs')).href);
  const {parseExportRequest,parseExportResult,exportResponseContext}=await import(pathToFileURL(path.join(hostRoot,'ordinary-export-protocol.mjs')).href);
  const { ModelSettingsHost }=await import(pathToFileURL(path.join(hostRoot,'model-settings.mjs')).href);
  const { parseModelSettingsRequest,parseModelSettingsResult,modelResponseContext }=await import(pathToFileURL(path.join(hostRoot,'model-settings-protocol.mjs')).href);
  const {ResearchSettingsHost}=await import(pathToFileURL(path.join(hostRoot,'research-settings.mjs')).href);
  const {parseResearchSettingsRequest,parseResearchSettingsResult,researchResponseContext}=await import(pathToFileURL(path.join(hostRoot,'research-settings-protocol.mjs')).href);
  const { BasicSettingsHost }=await import(pathToFileURL(path.join(hostRoot,'basic-settings.mjs')).href);
  const { MaintenanceIO }=await import(pathToFileURL(path.join(hostRoot,'maintenance-io.mjs')).href);
  const { parseBasicSettingsRequest,parseBasicSettingsResult }=await import(pathToFileURL(path.join(hostRoot,'basic-settings-protocol.mjs')).href);
  const rawObserver = new WiredObserver({ script: path.join(hostRoot, 'wired_observer.py') });
  const io=new MaintenanceIO();let basic,model,archive,research;
  const forget = new MemoryForgetHost({ observer: rawObserver,io,beforeIO:()=>{research?.invalidate();basic?.invalidate();model?.invalidate();archive?.invalidate();} });
  basic=new BasicSettingsHost({observer:rawObserver,io,beforeIO:()=>{research?.invalidate();forget.invalidate();model?.invalidate();archive?.invalidate();}});
  model=new ModelSettingsHost({observer:rawObserver,io,beforeIO:()=>{research?.invalidate();forget.invalidate();basic.invalidate();archive?.invalidate();}});
  archive=new OrdinaryExportHost({observer:rawObserver,io,beforeIO:()=>{research?.invalidate();forget.invalidate();basic.invalidate();model.invalidate();}});
  research=new ResearchSettingsHost({observer:rawObserver,io,beforeIO:()=>{forget.invalidate();basic.invalidate();model.invalidate();archive.invalidate();}});
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
  window.webContents.on('did-start-navigation', event => { if(event.isMainFrame && !event.isSameDocument) observer.cancel(); });
  ipcMain.handle('manager:ordinaryExport',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Ordinary export caller refused');
    let request=parseExportRequest(args[0]);args.length=0;
    try{const context=exportResponseContext(request),pending=archive.request(request);request=null;const value=parseExportResult(await pending,context,validateResult);return archive.assertCurrent(value);}finally{request=null;}
  });
  ipcMain.handle('manager:researchSettings',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Research settings caller refused');
    let request=parseResearchSettingsRequest(args[0]);args.length=0;
    try{const context=researchResponseContext(request),pending=research.request(request);request=null;const value=parseResearchSettingsResult(await pending,context,validateResult);return research.assertCurrent(value);}finally{request=null;}
  });
  ipcMain.handle('manager:modelSettings',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Model settings caller refused');
    let request=parseModelSettingsRequest(args[0]);args.length=0;
    try{const context=modelResponseContext(request),pending=model.request(request);request=null;const value=parseModelSettingsResult(await pending,context,validateResult);return model.assertCurrent(value);}finally{request=null;}
  });
  ipcMain.handle('manager:basicSettings',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Basic settings caller refused');
    const request=parseBasicSettingsRequest(args[0]);const value=parseBasicSettingsResult(await basic.request(request),request,validateResult);return basic.assertCurrent(value);
  });
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
  ipcMain.handle('manager:inspectSavedConfiguration',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Saved configuration caller refused');
    const request=parseSavedConfigurationRequest(args[0]);
    const pending=observer.inspectSavedConfiguration(request),generation=observer.generation;
    const value=parseSavedConfigurationResult(await pending,request,validateResult);
    if(generation!==observer.generation)throw Error('Inspection invalidated');
    return value;
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
