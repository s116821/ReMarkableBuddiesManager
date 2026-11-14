const { app, BrowserWindow, session, shell, ipcMain } = require('electron');
const { stat } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const GUIDE = 'https://github.com/s116821/RemarkableBuddiesDocs';
const browserHelperMode = app.isPackaged && process.argv.slice(1).includes('--browser-helper');

async function runBrowserHelper(hostRoot) {
  let helper, quitting = false, stopped = false, stopping;
  const stop = (code = 0) => stopping ??= Promise.resolve().then(async () => {
    try { if (helper) await helper.close(); }
    catch { code = 1; }
    finally {
      if (code) console.error('Manager browser helper unavailable');
      stopped = true;
      if (code) app.exit(code);
      else app.quit();
    }
  });
  // Wait for startup to settle before allowing quit to complete.
  const startup = (async () => {
    const { startHelper } = await import(pathToFileURL(path.join(hostRoot, 'browser-helper.mjs')).href);
    const root = path.join(app.getAppPath(), 'dist', 'manager', 'browser');
    if (!(await stat(path.join(root, 'index.html'))).isFile()) throw Error('Missing browser UI');
    helper = await startHelper({ root });
  })();
  const quit = () => { void startup.then(() => stop(), () => stop(1)); };
  app.on('before-quit', event => {
    if (stopped) return;
    event.preventDefault();
    quitting = true;
    quit();
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    quitting = true;
    quit();
  });
  try {
    await startup;
    if (quitting) return;
    const origin = new URL(helper.origin);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.origin !== helper.origin) {
      throw Error('Invalid helper origin');
    }
    const url = new URL('/preview/', origin).href;
    if (process.env.MANAGER_TEST !== '1') await shell.openExternal(url);
    if (quitting) return;
    if (process.env.MANAGER_TEST === '1') globalThis.managerBrowserHelperOrigin = origin.origin;
    console.log('Open the local Manager: ' + url);
  } catch { await stop(1); }
}

app.setName('ReMarkableBuddies Manager');
if (process.env.MANAGER_TEST === '1' && process.env.MANAGER_TEST_PROFILE) app.setPath('userData', process.env.MANAGER_TEST_PROFILE);
app.whenReady().then(async () => {
  const hostRoot = app.isPackaged ? path.join(process.resourcesPath, 'host') : path.join(__dirname, '../host');
  if (browserHelperMode) return runBrowserHelper(hostRoot);
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
  const {CredentialReferenceHost}=await import(pathToFileURL(path.join(hostRoot,'credential-reference.mjs')).href);
  const {parseCredentialReferenceRequest,parseCredentialReferenceResult,credentialResponseContext}=await import(pathToFileURL(path.join(hostRoot,'credential-reference-protocol.mjs')).href);
  const {MemorySettingsHost}=await import(pathToFileURL(path.join(hostRoot,'memory-settings.mjs')).href);
  const {parseMemorySettingsRequest,parseMemorySettingsResult,memoryResponseContext}=await import(pathToFileURL(path.join(hostRoot,'memory-settings-protocol.mjs')).href);
  const { ProductSettingsHost }=await import(pathToFileURL(path.join(hostRoot,'product-settings.mjs')).href);
  const { BasicSettingsHost }=await import(pathToFileURL(path.join(hostRoot,'basic-settings.mjs')).href);
  const {LocalModeChoiceHost}=await import(pathToFileURL(path.join(hostRoot,'local-mode-choice.mjs')).href);
  const {IsolatedRootHost}=await import(pathToFileURL(path.join(hostRoot,'isolated-root.mjs')).href);
  const {parseIsolatedRootRequest,parseIsolatedRootResult}=await import(pathToFileURL(path.join(hostRoot,'isolated-root-protocol.mjs')).href);
  const {parseLocalModeRequest,parseLocalModeResult}=await import(pathToFileURL(path.join(hostRoot,'local-mode-choice-protocol.mjs')).href);
  const { MaintenanceIO }=await import(pathToFileURL(path.join(hostRoot,'maintenance-io.mjs')).href);
  const { parseProductSettingsRequest,parseProductSettingsResult }=await import(pathToFileURL(path.join(hostRoot,'product-settings-protocol.mjs')).href);
  const { parseBasicSettingsRequest,parseBasicSettingsResult }=await import(pathToFileURL(path.join(hostRoot,'basic-settings-protocol.mjs')).href);
  const rawObserver = new WiredObserver({ script: path.join(hostRoot, 'wired_observer.py') });
  const {ModelCredentialHost}=await import(pathToFileURL(path.join(hostRoot,'model-credential.mjs')).href);
  const {parseModelCredentialRequest,parseModelCredentialResult,modelCredentialContext}=await import(pathToFileURL(path.join(hostRoot,'model-credential-protocol.mjs')).href);
  const {StorageInitializationHost}=await import(pathToFileURL(path.join(hostRoot,'storage-initialization.mjs')).href);
  const {parseStorageInitializationRequest,parseStorageInitializationResult}=await import(pathToFileURL(path.join(hostRoot,'storage-initialization-protocol.mjs')).href);
  const {OwnedDataV3Host}=await import(pathToFileURL(path.join(hostRoot,'owned-data-v3.mjs')).href);
  const {parseOwnedV3Request,parseOwnedV3Result}=await import(pathToFileURL(path.join(hostRoot,'owned-data-v3-protocol.mjs')).href);
  const {SourceCacheInventoryHost}=await import(pathToFileURL(path.join(hostRoot,'source-cache-inventory.mjs')).href);
  const {ConversationInventoryHost}=await import(pathToFileURL(path.join(hostRoot,'conversation-inventory.mjs')).href);
  const {parseSourceCacheRequest,parseSourceCacheResult}=await import(pathToFileURL(path.join(hostRoot,'source-cache-inventory-protocol.mjs')).href);
  const {parseConversationRequest,parseConversationResult}=await import(pathToFileURL(path.join(hostRoot,'conversation-inventory-protocol.mjs')).href);
  const {SourceCacheCleanupHost}=await import(pathToFileURL(path.join(hostRoot,'source-cache-cleanup.mjs')).href);
  const {parseCleanupRequest,parseCleanupResult}=await import(pathToFileURL(path.join(hostRoot,'source-cache-cleanup-protocol.mjs')).href);
  const {HandwritingRecordsHost}=await import(pathToFileURL(path.join(hostRoot,'handwriting-records.mjs')).href);
  const {parseHandwritingRequest,parseHandwritingResult}=await import(pathToFileURL(path.join(hostRoot,'handwriting-records-protocol.mjs')).href);
  const {NotebookArchiveHost}=await import(pathToFileURL(path.join(hostRoot,'notebook-archive.mjs')).href);
  const {parseArchiveRequest:parseNotebookRequest,parseArchiveResult:parseNotebookResult}=await import(pathToFileURL(path.join(hostRoot,'notebook-archive-protocol.mjs')).href);
  const {SelectedArchiveHost}=await import(pathToFileURL(path.join(hostRoot,'selected-archive.mjs')).href);
  const {parseArchiveRequest,parseArchiveResult}=await import(pathToFileURL(path.join(hostRoot,'selected-archive-protocol.mjs')).href);
  const {OrdinaryRestoreHost}=await import(pathToFileURL(path.join(hostRoot,'ordinary-restore.mjs')).href);
  const {parseRestoreRequest,parseRestoreResult,parseNotebookRestoreResult,restoreResponseContext}=await import(pathToFileURL(path.join(hostRoot,'ordinary-restore-protocol.mjs')).href);
  const {ConversationManagementHost}=await import(pathToFileURL(path.join(hostRoot,'conversation-management.mjs')).href);
  const {parseManagementRequest,parseManagementResult}=await import(pathToFileURL(path.join(hostRoot,'conversation-management-protocol.mjs')).href);
  const {PortableConfigurationHost}=await import(pathToFileURL(path.join(hostRoot,'portable-configuration.mjs')).href);
  const {parsePortableRequest,portableContext,parsePortableResult}=await import(pathToFileURL(path.join(hostRoot,'portable-configuration-protocol.mjs')).href);
  const {SharedPreferencesHost, registerSharedPreferenceHandler} = await import(pathToFileURL(path.join(hostRoot, 'shared-preferences.mjs')).href);
  const io=new MaintenanceIO();let sharedPreferences,portable,notebook,storageInitialization,ownedV3,localMode,isolatedRoot,product,basic,model,archive,research,memorySettings,credential,modelCredential,sourceCache,cacheCleanup,conversations,management,restore,notebookRestore,selected,handwriting;
  const invalidatePeers=owner=>{for(const peer of [sharedPreferences,portable,notebookRestore,notebook,storageInitialization,ownedV3,localMode,isolatedRoot,product,basic,model,archive,research,memorySettings,credential,modelCredential,sourceCache,cacheCleanup,conversations,management,restore,selected,handwriting,forget])if(peer&&peer!==owner)peer.invalidate();};
  const forget = new MemoryForgetHost({ observer: rawObserver,io,beforeIO:()=>invalidatePeers(forget) });
  portable=new PortableConfigurationHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(portable)});
  basic=new BasicSettingsHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(basic)});
  product=new ProductSettingsHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(product)});
  model=new ModelSettingsHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(model)});
  archive=new OrdinaryExportHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(archive)});
  research=new ResearchSettingsHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(research)});
  memorySettings=new MemorySettingsHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(memorySettings)});
  credential=new CredentialReferenceHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(credential)});
  modelCredential=new ModelCredentialHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(modelCredential)});
  sourceCache=new SourceCacheInventoryHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(sourceCache)});
  ownedV3=new OwnedDataV3Host({observer:rawObserver,io,beforeIO:()=>invalidatePeers(ownedV3)});
  storageInitialization=new StorageInitializationHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(storageInitialization)});
  cacheCleanup=new SourceCacheCleanupHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(cacheCleanup)});
  conversations=new ConversationInventoryHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(conversations)});
  management=new ConversationManagementHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(management)});
  restore=new OrdinaryRestoreHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(restore)});
  notebookRestore=new OrdinaryRestoreHost({family:'notebook',observer:rawObserver,io,beforeIO:()=>invalidatePeers(notebookRestore)});
  sharedPreferences = new SharedPreferencesHost({observer: rawObserver, io, beforeIO: () => invalidatePeers(sharedPreferences)});
  const observer = forget.wrap();
  selected=new SelectedArchiveHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(selected)});
  notebook=new NotebookArchiveHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(notebook)});
  handwriting=new HandwritingRecordsHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(handwriting)});
  localMode=new LocalModeChoiceHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(localMode)});
  isolatedRoot=new IsolatedRootHost({observer:rawObserver,io,beforeIO:()=>invalidatePeers(isolatedRoot)});
  const { DriveAuth } = await import(pathToFileURL(path.join(hostRoot, 'drive-auth.mjs')).href);
  const driveAuth = new DriveAuth();
  const {IsolatedBackupHost} = await import(pathToFileURL(path.join(hostRoot, 'isolated-backup-host.mjs')).href);
  const {ISOLATED_BACKUP_REQUEST_BYTES, parseIsolatedBackupRequest, parseIsolatedBackupResult} =
    await import(pathToFileURL(path.join(hostRoot, 'isolated-backup-protocol.mjs')).href);
  const isolatedBackup = new IsolatedBackupHost({driveAuth});
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
  window.webContents.on('did-start-navigation', event => {
    if (event.isMainFrame && !event.isSameDocument) { observer.cancel(); isolatedBackup.invalidate(); }
  });
  registerSharedPreferenceHandler(ipcMain, authorized, sharedPreferences);
  ipcMain.handle('manager:portableConfiguration',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Portable preferences caller refused');
    let q=parsePortableRequest(args[0]);const context=portableContext(q),pending=portable.request(q);q=null;const value=parsePortableResult(await pending,context,validateResult);return portable.assertCurrent(value);
  });
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
  ipcMain.handle('manager:memorySettings',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Memory settings caller refused');
    let request=parseMemorySettingsRequest(args[0]);args.length=0;
    try{const context=memoryResponseContext(request),pending=memorySettings.request(request);request=null;const value=parseMemorySettingsResult(await pending,context,validateResult);return memorySettings.assertCurrent(value);}finally{request=null;}
  });
  ipcMain.handle('manager:handwritingRecords',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Archive caller refused');
    let request=parseHandwritingRequest(args[0]);args.length=0;
    try{const context=handwriting.context(request),pending=handwriting.request(request);request=null;const value=await parseHandwritingResult(await pending,context,validateResult);return handwriting.assertCurrent(value);}finally{request=null;}
  });
  ipcMain.handle('manager:selectedArchive',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Archive caller refused');
    let request=parseArchiveRequest(args[0]);args.length=0;
    try{const context=selected.context(request),pending=selected.request(request);request=null;const value=parseArchiveResult(await pending,context,validateResult);return selected.assertCurrent(value);}finally{request=null;}
  });
  ipcMain.handle('manager:notebookArchive',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Archive caller refused');
    let request=parseNotebookRequest(args[0]);args.length=0;
    try{const context=notebook.context(request),pending=notebook.request(request);request=null;const value=parseNotebookResult(await pending,context,validateResult);return notebook.assertCurrent(value);}finally{request=null;}
  });
  for(const [channel,host,parseResult] of [['manager:ordinaryRestore',restore,parseRestoreResult],['manager:notebookRestore',notebookRestore,parseNotebookRestoreResult]])ipcMain.handle(channel,async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Ordinary restore caller refused');
    let request=parseRestoreRequest(args[0]);args.length=0;
    try{const context=restoreResponseContext(request),pending=host.request(request);request=null;const value=parseResult(await pending,context,validateResult);return host.assertCurrent(value);}finally{request=null;}
  });
  ipcMain.handle('manager:conversationManagement',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Conversation management caller refused');
    let request=parseManagementRequest(args[0]);args.length=0;
    try{const context=request,pending=management.request(request);request=null;const value=parseManagementResult(await pending,context,validateResult);return management.assertCurrent(value);}finally{request=null;}
  });
  ipcMain.handle('manager:sourceCacheCleanup',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Cache cleanup caller refused');
    let request=parseCleanupRequest(args[0]);args.length=0;
    try{const context=request,pending=cacheCleanup.request(request);request=null;const value=parseCleanupResult(await pending,context,validateResult);return cacheCleanup.assertCurrent(value);}finally{request=null;}
  });
  ipcMain.handle('manager:inspectConversations',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Conversation inventory caller refused');
    let request=parseConversationRequest(args[0]);args.length=0;
    try{const context=request,pending=conversations.request(request);request=null;const value=parseConversationResult(await pending,context,validateResult);return conversations.assertCurrent(value);}finally{request=null;}
  });
  ipcMain.handle('manager:storageInitialization',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Storage setup caller refused');
    let request=parseStorageInitializationRequest(args[0]);args.length=0;
    try{const context=request,pending=storageInitialization.request(request);request=null;const value=parseStorageInitializationResult(await pending,context,validateResult);return storageInitialization.assertCurrent(value);}finally{request=null;}
  });
  ipcMain.handle('manager:inspectOwnedV3',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Stored data inspection caller refused');
    let request=parseOwnedV3Request(args[0]);args.length=0;
    try{const context=request,pending=ownedV3.request(request);request=null;const value=parseOwnedV3Result(await pending,context,validateResult);return ownedV3.assertCurrent(value);}finally{request=null;}
  });
  ipcMain.handle('manager:inspectSourceCache',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Source cache inventory caller refused');
    let request=parseSourceCacheRequest(args[0]);args.length=0;
    try{const context=request,pending=sourceCache.request(request);request=null;const value=parseSourceCacheResult(await pending,context,validateResult);return sourceCache.assertCurrent(value);}finally{request=null;}
  });
  ipcMain.handle('manager:modelCredential',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Model credential caller refused');
    let request=parseModelCredentialRequest(args[0]);args.length=0;
    try{const context=modelCredentialContext(request),pending=modelCredential.request(request);request=null;const value=parseModelCredentialResult(await pending,context,validateResult);return modelCredential.assertCurrent(value);}finally{request=null;}
  });
  ipcMain.handle('manager:credentialReference',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Credential reference caller refused');
    let request=parseCredentialReferenceRequest(args[0]);args.length=0;
    try{const context=credentialResponseContext(request),pending=credential.request(request);request=null;const value=parseCredentialReferenceResult(await pending,context,validateResult);return credential.assertCurrent(value);}finally{request=null;}
  });
  ipcMain.handle('manager:modelSettings',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Model settings caller refused');
    let request=parseModelSettingsRequest(args[0]);args.length=0;
    try{const context=modelResponseContext(request),pending=model.request(request);request=null;const value=parseModelSettingsResult(await pending,context,validateResult);return model.assertCurrent(value);}finally{request=null;}
  });
  ipcMain.handle('manager:isolated-backup', (event, ...args) => {
    if (!authorized(event, []) || args.length !== 1) throw Error('Backup inspection caller refused');
    const request = parseIsolatedBackupRequest(args[0]);
    if (Buffer.byteLength(JSON.stringify(request)) > ISOLATED_BACKUP_REQUEST_BYTES) throw Error('Backup inspection input refused');
    return parseIsolatedBackupResult(isolatedBackup.request(request), request);
  });
  ipcMain.handle('manager:isolatedRoot',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Isolated backup caller refused');
    const request=parseIsolatedRootRequest(args[0]);const value=parseIsolatedRootResult(await isolatedRoot.request(request),request,validateResult);return isolatedRoot.assertCurrent(value);
  });
  ipcMain.handle('manager:localModeChoice',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Local-only choice caller refused');
    const request=parseLocalModeRequest(args[0]);const value=parseLocalModeResult(await localMode.request(request),request,validateResult);return localMode.assertCurrent(value);
  });
  ipcMain.handle('manager:productSettings',async(event,...args)=>{
    if(!authorized(event,[])||args.length!==1)throw Error('Product settings caller refused');
    const request=parseProductSettingsRequest(args[0]);const value=parseProductSettingsResult(await product.request(request),request,validateResult);return product.assertCurrent(value);
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
  window.on('closed', () => { sharedPreferences.dispose(); portable.dispose(); observer.cancel(); restore.dispose(); notebookRestore.dispose(); localMode.dispose(); isolatedRoot.dispose(); isolatedBackup.dispose(); driveAuth.dispose(); downloads.dispose(); });
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
if (!browserHelperMode) app.on('window-all-closed', () => app.quit());
