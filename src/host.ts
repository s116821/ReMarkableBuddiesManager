import type {SharedPreferenceAdapter} from './shared-preferences';
import type {TabletDriveSetupAdapter} from './tablet-drive-setup';
import {parseTabletDriveSetupResult, type TabletDriveSetupRequest} from '../host/tablet-drive-setup-protocol.mjs';
import {BACKUP_PREFERENCES_RESPONSE_BYTES, ISOLATED_BACKUP_RESPONSE_BYTES, parseIsolatedBackupJson,
  parseIsolatedBackupBridgeRequest, parseIsolatedBackupBridgeResult,
  type IsolatedBackupBridgeRequest, type IsolatedBackupBridgeResult} from '../host/isolated-backup-protocol.mjs';
import {FRAME_LIMIT, type SharedPreferenceRequest, type SharedPreferenceResult} from '../host/shared-preferences-protocol.mjs';
import {portableJson} from '../host/portable-configuration-protocol.mjs';
import type {PortableAdapter} from './portable-configuration';
import type {PortableResult} from '../host/portable-configuration-protocol.mjs';
import type {ArchiveRequest as NotebookRequest,ArchiveResult as NotebookResult} from '../host/notebook-archive-protocol.mjs';
import {parseArchiveJson as parseNotebookJson} from '../host/notebook-archive-protocol.mjs';
import type {StorageInitializationAdapter} from './storage-initialization';
import type {FirstConfigRequest, FirstConfigResult} from '../host/first-configuration-protocol.mjs';
import type {OwnedV3Adapter} from './owned-data-v3';
import type {LocalModeAdapter} from './local-mode-choice';
import type {LocalModeResult} from '../host/local-mode-choice-protocol.mjs';
import type {IsolatedRootRequest,IsolatedRootResult} from '../host/isolated-root-protocol.mjs';
import {strictJson as strictIsolatedRootJson} from '../host/strict-json.mjs';
import type{HandwritingRequest,HandwritingResult}from'../host/handwriting-records-protocol.mjs';
import{parseHandwritingJson}from'../host/handwriting-records-protocol.mjs';
import type {ArchiveRequest,ArchiveResult} from '../host/selected-archive-protocol.mjs';
import {parseArchiveJson} from '../host/selected-archive-protocol.mjs';
import type {RestoreAdapter} from './ordinary-restore';
import type {RestoreRequest, RestoreResult} from '../host/ordinary-restore-protocol.mjs';
import {parseRestoreJson} from '../host/ordinary-restore-protocol.mjs';
import type {ManagementAdapter} from './conversation-management';
import type {ManagementResult} from '../host/conversation-management-protocol.mjs';
import {parseManagementJson} from '../host/conversation-management-protocol.mjs';
import type {ConversationAdapter} from './conversation-inventory';
import type {ConversationResult} from '../host/conversation-inventory-protocol.mjs';
import type {CleanupAdapter} from './source-cache-cleanup';
import type {CleanupResult} from '../host/source-cache-cleanup-protocol.mjs';
import type {SourceCacheAdapter} from './source-cache-inventory';
import type {SourceCacheResult} from '../host/source-cache-inventory-protocol.mjs';
import type {ModelCredentialAdapter} from './model-credential';
import type {ModelCredentialResult} from '../host/model-credential-protocol.mjs';
import type {CredentialReferenceAdapter} from './credential-reference';
import type {CredentialReferenceResult} from '../host/credential-reference-protocol.mjs';
import type {ResearchSettingsAdapter} from './research-settings';
import type {ResearchSettingsResult} from '../host/research-settings-protocol.mjs';
import type {MemorySettingsAdapter} from './memory-settings';
import type {MemorySettingsResult} from '../host/memory-settings-protocol.mjs';
import type {OrdinaryExportAdapter} from './ordinary-export';
import type {ExportResult} from '../host/ordinary-export-protocol.mjs';
import type { ModelSettingsAdapter } from './model-settings';
import type { ModelSettingsResult } from '../host/model-settings-protocol.mjs';
import type { ProductSettingsAdapter } from './product-settings';
import type { BasicSettingsAdapter } from './basic-settings';
import type { ProductSettingsResult } from '../host/product-settings-protocol.mjs';
import type { BasicSettingsResult } from '../host/basic-settings-protocol.mjs';
import type { SavedConfigurationAdapter,SavedConfigurationResult } from './saved-configuration';
import type { ForgetAdapter, ForgetResult } from './memory-forget';
import type { MemoryInspectionAdapter, MemoryInspectionResult } from './memory-inspection';
import type { MemoryAdapter, MemoryResult } from './memory-query';
import type { SavedModeAdapter, SavedModeResult } from './saved-mode';
import type { DownloadAdapter } from './manager-downloads';
import type { RuntimeAdapter, RuntimeResult } from './runtime-identity';
import type { PersonalizationRequest } from '../host/personalization.mjs';
import type { PersonalizationAdapter, PersonalizationResult } from './personalization';
import type { DriveAdapter } from './drive-auth';
import { parseDriveState, parseDriveBegin, unavailableDrive } from '../host/drive-protocol.mjs';
import type { InspectionAdapter, InspectionResult } from './owned-data';
import type { ObservationAdapter, ObservationResult } from './observation';
function isLoopbackHelper() {
  return location.hostname === '127.0.0.1' && location.protocol === 'http:';
}

function postHelper(route: string, request: unknown, timeout = 14000) {
  return fetch(route, {method: 'POST', credentials: 'same-origin',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(request), signal: AbortSignal.timeout(timeout)});
}

type BridgeParser = (raw: Uint8Array<ArrayBuffer>) => unknown;
type ReaderCleanup = 'incomplete' | 'always' | 'always-and-release';

const maintenanceJson: BridgeParser = raw =>
  JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(raw));
const legacyJson: BridgeParser = raw =>
  JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw));

async function boundedBody(body: NonNullable<Response['body']>, limit: number, refused: string, cleanup: ReaderCleanup = 'incomplete') {
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0, complete = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { complete = true; break; }
      bytes += part.value.byteLength;
      if (bytes > limit) throw Error(refused);
      chunks.push(part.value);
    }
  } finally {
    if (!complete || cleanup !== 'incomplete') await reader.cancel().catch(() => {});
    if (cleanup !== 'always') reader.releaseLock();
  }
  const raw = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
  return raw;
}

function maintenanceBridge<Q, R>(
  route: string, operation: string, parse: BridgeParser = maintenanceJson, limit = 8192, responseLabel = operation,
) {
  return async (request: Q | null): Promise<R> => {
    if (!isLoopbackHelper()) throw Error(operation + ' helper unavailable');
    const pending = postHelper(route, request);
    request = null;
    const response = await pending;
    if (!response.ok || !response.body) throw Error(operation + ' unavailable');
    return parse(await boundedBody(response.body, limit, responseLabel + ' response refused')) as R;
  };
}

interface LegacyBridgeOptions {
  parse?: BridgeParser;
  timeout?: number;
  clearAfterPost?: boolean;
  helperFailure?: boolean;
  releaseLock?: boolean;
  responseLabel?: string;
  gate?: string;
}

// These original readers cancel even at EOF. Retain their per-route lock
// release and request clearing instead of using the maintenance cleanup.
function legacyBridge<Q, R>(
  route: string, operation: string, limit = 8192,
  {parse = legacyJson, timeout, clearAfterPost, helperFailure, releaseLock, responseLabel = operation,
    gate = operation + ' helper unavailable'}: LegacyBridgeOptions = {},
) {
  return async (request: Q | null): Promise<R> => {
    if (!isLoopbackHelper()) throw Error(gate);
    const pending = postHelper(route, request, timeout);
    if (clearAfterPost) request = null;
    const response = await pending;
    if (!response.ok || !response.body) throw Error(helperFailure ? gate : operation + ' unavailable');
    return parse(await boundedBody(response.body, limit, responseLabel + ' response refused',
      releaseLock ? 'always-and-release' : 'always')) as R;
  };
}

export interface ManagerHost extends ObservationAdapter, InspectionAdapter {
  readonly isolatedRoot?:(request:IsolatedRootRequest)=>Promise<IsolatedRootResult>;
  readonly isolatedBackup?:(request:IsolatedBackupBridgeRequest)=>Promise<IsolatedBackupBridgeResult>;
  readonly localModeChoice?:LocalModeAdapter['localModeChoice'];
  readonly sharedPreferences?: SharedPreferenceAdapter;
  readonly portableConfiguration?:PortableAdapter['portableConfiguration'];
  readonly ordinaryExport?:OrdinaryExportAdapter['ordinaryExport'];
  readonly researchSettings?:ResearchSettingsAdapter['researchSettings'];
  readonly memorySettings?:MemorySettingsAdapter['memorySettings'];
  readonly ordinaryRestore?:RestoreAdapter['ordinaryRestore'];
  readonly notebookRestore?:RestoreAdapter['notebookRestore'];
  readonly handwritingRecords?:(request:HandwritingRequest)=>Promise<HandwritingResult>;
  readonly selectedArchive?:(request:ArchiveRequest)=>Promise<ArchiveResult>;
  readonly notebookArchive?:(request:NotebookRequest)=>Promise<NotebookResult>;
  readonly conversationManagement?:ManagementAdapter['conversationManagement'];
  readonly sourceCacheCleanup?:CleanupAdapter['sourceCacheCleanup'];
  readonly inspectConversations?:ConversationAdapter['inspectConversations'];
  readonly firstConfiguration?:(request: FirstConfigRequest)=>Promise<FirstConfigResult>;
  readonly storageInitialization?:StorageInitializationAdapter['storageInitialization'];
  readonly inspectOwnedV3?:OwnedV3Adapter['inspectOwnedV3'];
  readonly inspectSourceCache?:SourceCacheAdapter['inspectSourceCache'];
  readonly modelCredential?:ModelCredentialAdapter['modelCredential'];
  readonly credentialReference?:CredentialReferenceAdapter['credentialReference'];
  readonly modelSettings?: ModelSettingsAdapter['modelSettings'];
  readonly productSettings?: ProductSettingsAdapter['productSettings'];
  readonly basicSettings?: BasicSettingsAdapter['basicSettings'];
  readonly memoryForget?: ForgetAdapter['memoryForget'];
  readonly inspectMemory?: MemoryInspectionAdapter['inspectMemory'];
  readonly inspectSavedConfiguration?: SavedConfigurationAdapter['inspectSavedConfiguration'];
  readonly inspectSavedMode?: SavedModeAdapter['inspectSavedMode'];
  readonly memoryQuery?: MemoryAdapter['memoryQuery'];
  readonly downloads?: DownloadAdapter;
  readonly driveAuth?: DriveAdapter;
  readonly tabletDriveSetup?: TabletDriveSetupAdapter;
  readonly inspectRuntime?: RuntimeAdapter['inspectRuntime'];
  readonly personalization?: PersonalizationAdapter['personalization'];
  readonly contract_version: 1;
  readonly kind: 'browser' | 'desktop';
  readonly transport: 'not-configured' | 'wired-maintenance';
}
declare global { interface Window { managerHost?: ManagerHost } }
async function helper(action: 'observe' | 'cancel' | 'inspect-owned' | 'inspect-runtime'): Promise<ObservationResult | InspectionResult | RuntimeResult> {
  if (!isLoopbackHelper()) return { contract_version: 1, status: 'unconfigured', observation: null };
  try {
    const response = await postHelper('/manager-host', { action });
    if (!response.ok) throw new Error('Helper unavailable');
    return await response.json() as ObservationResult;
  } catch { return { contract_version: 1, status: 'unconfigured', observation: null }; }
}
async function driveHelper(action: string, authorizationId?: string) {
  if (!isLoopbackHelper()) throw new Error('Drive helper unavailable');
  const response = await postHelper('/manager-drive', action === 'revoke' ? { action, authorizationId } : { action }, 60000);
  if (!response.ok) throw new Error('Drive helper unavailable');
  const value: unknown = await response.json(); return action === 'begin' ? parseDriveBegin(value) : parseDriveState(value);
}
const browserDrive: DriveAdapter = {
  status: () => driveHelper('status') as ReturnType<DriveAdapter['status']>, begin: () => driveHelper('begin') as ReturnType<DriveAdapter['begin']>,
  check: () => driveHelper('check') as ReturnType<DriveAdapter['check']>, cancel: () => driveHelper('cancel') as ReturnType<DriveAdapter['cancel']>,
  disconnect: () => driveHelper('disconnect') as ReturnType<DriveAdapter['disconnect']>, revoke: id => driveHelper('revoke', id) as ReturnType<DriveAdapter['revoke']>,
};
export const unsupportedDrive: DriveAdapter = { status: async () => unavailableDrive(), begin: async () => ({ state: unavailableDrive(), authorizationUrl: null }),
  check: async () => unavailableDrive(), cancel: async () => unavailableDrive(), disconnect: async () => unavailableDrive(), revoke: async () => unavailableDrive() };
export function currentHost(): ManagerHost {
  return window.managerHost ?? Object.freeze({
    tabletDriveSetup: async (request: TabletDriveSetupRequest) => {
      if (!isLoopbackHelper()) throw Error('Tablet Drive helper unavailable');
      const read = legacyBridge<TabletDriveSetupRequest, unknown>('/manager-tablet-drive', 'Tablet Drive', 8192,
        {timeout: 20000, helperFailure: true, responseLabel: 'Tablet Drive', gate: 'Tablet Drive helper unavailable'});
      return parseTabletDriveSetupResult(await read(request), request);
    },
    downloads: {request: legacyBridge<import('../host/manager-download-protocol.mjs').DownloadRequest, unknown>(
      '/manager-download', 'Download host', 2048, {timeout: 10000, helperFailure: true, responseLabel: 'Download', gate: 'Download host unavailable'})}, driveAuth: browserDrive, contract_version: 1 as const, kind: 'browser' as const, transport: 'not-configured' as const,
    sharedPreferences: async (request: SharedPreferenceRequest | null) => {
      if (!isLoopbackHelper()) throw Error('Shared preferences helper unavailable');
      const pending = postHelper('/manager-shared-preferences', request);
      request = null;
      const response = await pending;
      if (!response.ok || !response.body) throw Error('Shared preferences unavailable');
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0, complete = false;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) { complete = true; break; }
          chunks.push(part.value);
          size += part.value.length;
          if (size > FRAME_LIMIT) throw Error('Shared response refused');
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        try { return portableJson(bytes, FRAME_LIMIT) as SharedPreferenceResult; }
        finally { bytes.fill(0); }
      } finally {
        if (!complete) await reader.cancel().catch(() => {});
        reader.releaseLock();
        for (const chunk of chunks) chunk.fill(0);
      }
    },
    portableConfiguration: async (request:import('../host/portable-configuration-protocol.mjs').PortableRequest|null)=>{
      if(!isLoopbackHelper())throw Error('Portable preferences helper unavailable');
      const pending=postHelper('/manager-portable-configuration', request);request=null;const response=await pending;
      if(!response.ok||!response.body)throw Error('Portable preferences unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0,complete=false;
      try{for(;;){const item=await reader.read();if(item.done){complete=true;break;}bytes+=item.value.byteLength;if(bytes>196608){item.value.fill(0);throw Error('Portable response refused');}chunks.push(item.value);}const raw=new Uint8Array(bytes);let at=0;for(const chunk of chunks){raw.set(chunk,at);at+=chunk.length;}try{return portableJson(raw,196608) as PortableResult;}finally{raw.fill(0);}}
      finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();for(const chunk of chunks)chunk.fill(0);chunks.length=0;}
    },
    ordinaryExport: legacyBridge<import('../host/ordinary-export-protocol.mjs').ExportRequest, ExportResult>(
      '/manager-ordinary-export', 'Ordinary export', 8192, {parse: maintenanceJson, clearAfterPost: true, responseLabel: 'Export'}),
    researchSettings: maintenanceBridge<import('../host/research-settings-protocol.mjs').ResearchSettingsRequest, ResearchSettingsResult>(
      '/manager-research-settings', 'Research settings', undefined, undefined, 'Research'),
    memorySettings: maintenanceBridge<import('../host/memory-settings-protocol.mjs').MemorySettingsRequest, MemorySettingsResult>(
      '/manager-memory-settings', 'Memory settings', undefined, undefined, 'Memory'),
    handwritingRecords: maintenanceBridge<HandwritingRequest, HandwritingResult>(
      '/manager-handwriting-records', 'Archive operation', parseHandwritingJson, 270336),
    selectedArchive: maintenanceBridge<ArchiveRequest, ArchiveResult>(
      '/manager-selected-archive', 'Archive operation', parseArchiveJson),
    notebookArchive: maintenanceBridge<NotebookRequest, NotebookResult>(
      '/manager-notebook-archive', 'Archive operation', parseNotebookJson),
    ordinaryRestore: maintenanceBridge<RestoreRequest, RestoreResult>('/manager-ordinary-restore', 'Tablet maintenance', parseRestoreJson),
    notebookRestore: maintenanceBridge<RestoreRequest, RestoreResult>('/manager-notebook-restore', 'Tablet maintenance', parseRestoreJson),
    firstConfiguration: maintenanceBridge<FirstConfigRequest, FirstConfigResult>('/manager-first-configuration', 'Tablet maintenance', parseRestoreJson),
    conversationManagement: maintenanceBridge<import('../host/conversation-management-protocol.mjs').ManagementRequest, ManagementResult>(
      '/manager-conversation-management', 'Conversation management', parseManagementJson),
    sourceCacheCleanup: maintenanceBridge<import('../host/source-cache-cleanup-protocol.mjs').CleanupRequest, CleanupResult>(
      '/manager-source-cache-cleanup', 'Cache cleanup'),
    inspectConversations: maintenanceBridge<import('../host/conversation-inventory-protocol.mjs').ConversationRequest, ConversationResult>(
      '/manager-conversation-inventory', 'Conversation inventory'),
    storageInitialization: maintenanceBridge<import('../host/storage-initialization-protocol.mjs').StorageInitializationRequest, import('../host/storage-initialization-protocol.mjs').StorageInitializationResult>(
      '/manager-storage-initialization', 'Storage preparation'),
    inspectOwnedV3: maintenanceBridge<import('../host/owned-data-v3-protocol.mjs').OwnedV3Request, import('../host/owned-data-v3-protocol.mjs').OwnedV3Result>(
      '/manager-owned-data-v3', 'Stored data inspection', undefined, 16384),
    inspectSourceCache: maintenanceBridge<import('../host/source-cache-inventory-protocol.mjs').SourceCacheRequest, SourceCacheResult>(
      '/manager-source-cache-inventory', 'Source cache inventory'),
    modelCredential: maintenanceBridge<import('../host/model-credential-protocol.mjs').ModelCredentialRequest, ModelCredentialResult>(
      '/manager-model-credential', 'Model credential'),
    credentialReference: maintenanceBridge<import('../host/credential-reference-protocol.mjs').CredentialReferenceRequest, CredentialReferenceResult>(
      '/manager-credential-reference', 'Credential reference'),
    modelSettings: legacyBridge<import('../host/model-settings-protocol.mjs').ModelSettingsRequest, ModelSettingsResult>(
      '/manager-model-settings', 'Model settings', 8192, {parse: maintenanceJson, clearAfterPost: true, responseLabel: 'Model'}),
    isolatedBackup: async (input:IsolatedBackupBridgeRequest) => {
      if (!isLoopbackHelper()) throw Error('Backup inspection helper unavailable');
      const request = parseIsolatedBackupBridgeRequest(input);
      const limit = request.action.startsWith('preview-') ? BACKUP_PREFERENCES_RESPONSE_BYTES : ISOLATED_BACKUP_RESPONSE_BYTES;
      const response = await postHelper('/manager-isolated-backup', request);
      if (!response.ok || !response.body) throw Error('Backup inspection helper unavailable');
      const raw = await boundedBody(response.body, limit, 'Backup inspection response refused');
      return parseIsolatedBackupBridgeResult(parseIsolatedBackupJson(raw, limit), request);
    },
    isolatedRoot: legacyBridge<IsolatedRootRequest, IsolatedRootResult>(
      '/manager-isolated-root', 'Isolated backup', 8192, {parse: strictIsolatedRootJson, timeout: 46000, helperFailure: true, releaseLock: true}),
    localModeChoice: legacyBridge<import('../host/local-mode-choice-protocol.mjs').LocalModeRequest, LocalModeResult>(
      '/manager-local-mode-choice', 'Local-only', 8192, {helperFailure: true}),
    productSettings: legacyBridge<import('../host/product-settings-protocol.mjs').ProductSettingsRequest, ProductSettingsResult>(
      '/manager-product-settings', 'Product settings'),
    basicSettings: legacyBridge<import('../host/basic-settings-protocol.mjs').BasicSettingsRequest, BasicSettingsResult>(
      '/manager-basic-settings', 'Basic settings'),
    memoryForget: legacyBridge<import('../host/memory-forget-protocol.mjs').ForgetRequest, ForgetResult>(
      '/manager-memory-forget', 'Memory forget', 65536),
    inspectMemory: legacyBridge<import('../host/memory-inspection.mjs').MemoryInspectionRequest, MemoryInspectionResult>(
      '/manager-memory-inspection', 'Memory inspection', 270336),
    inspectSavedConfiguration: legacyBridge<import('../host/saved-configuration.mjs').SavedConfigurationRequest, SavedConfigurationResult>(
      '/manager-saved-configuration', 'Saved configuration', 32768),
    inspectSavedMode: legacyBridge<import('../host/saved-mode.mjs').SavedModeRequest, SavedModeResult>(
      '/manager-saved-mode', 'Saved mode', 16384),
    memoryQuery: legacyBridge<import('../host/memory-query.mjs').MemoryRequest, MemoryResult>(
      '/manager-memory-query', 'Memory query', 139264),
    personalization: async (request: PersonalizationRequest) => {
      if (!isLoopbackHelper()) throw new Error('Personalization helper unavailable');
      const response = await postHelper('/manager-personalization', request);
      if (!response.ok) throw new Error('Personalization unavailable');
      return await response.json() as PersonalizationResult;
    },
    inspectRuntime: () => helper('inspect-runtime') as Promise<RuntimeResult>,
    inspectOwned: () => helper('inspect-owned') as Promise<InspectionResult>,
    observe: () => helper('observe') as Promise<ObservationResult>, cancel: () => helper('cancel') as Promise<ObservationResult> });
}
