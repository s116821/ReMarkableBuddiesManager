import type{HandwritingRequest,HandwritingResult}from'../host/handwriting-records-protocol.mjs';
import{parseHandwritingJson}from'../host/handwriting-records-protocol.mjs';
import type {ArchiveRequest,ArchiveResult} from '../host/selected-archive-protocol.mjs';
import {parseArchiveJson} from '../host/selected-archive-protocol.mjs';
import type {RestoreAdapter} from './ordinary-restore';
import type {RestoreResult} from '../host/ordinary-restore-protocol.mjs';
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
export interface ManagerHost extends ObservationAdapter, InspectionAdapter {
  readonly ordinaryExport?:OrdinaryExportAdapter['ordinaryExport'];
  readonly researchSettings?:ResearchSettingsAdapter['researchSettings'];
  readonly memorySettings?:MemorySettingsAdapter['memorySettings'];
  readonly ordinaryRestore?:RestoreAdapter['ordinaryRestore'];
  readonly handwritingRecords?:(request:HandwritingRequest)=>Promise<HandwritingResult>;
  readonly selectedArchive?:(request:ArchiveRequest)=>Promise<ArchiveResult>;
  readonly conversationManagement?:ManagementAdapter['conversationManagement'];
  readonly sourceCacheCleanup?:CleanupAdapter['sourceCacheCleanup'];
  readonly inspectConversations?:ConversationAdapter['inspectConversations'];
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
  readonly inspectRuntime?: RuntimeAdapter['inspectRuntime'];
  readonly personalization?: PersonalizationAdapter['personalization'];
  readonly contract_version: 1;
  readonly kind: 'browser' | 'desktop';
  readonly transport: 'not-configured' | 'wired-maintenance';
}
declare global { interface Window { managerHost?: ManagerHost } }
async function helper(action: 'observe' | 'cancel' | 'inspect-owned' | 'inspect-runtime'): Promise<ObservationResult | InspectionResult | RuntimeResult> {
  if (location.hostname !== '127.0.0.1' || location.protocol !== 'http:') return { contract_version: 1, status: 'unconfigured', observation: null };
  try {
    const response = await fetch('/manager-host', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }), signal: AbortSignal.timeout(14000) });
    if (!response.ok) throw new Error('Helper unavailable');
    return await response.json() as ObservationResult;
  } catch { return { contract_version: 1, status: 'unconfigured', observation: null }; }
}
async function driveHelper(action: string, authorizationId?: string) {
  if (location.hostname !== '127.0.0.1' || location.protocol !== 'http:') throw new Error('Drive helper unavailable');
  const response = await fetch('/manager-drive', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action === 'revoke' ? { action, authorizationId } : { action }), signal: AbortSignal.timeout(60000) });
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
  return window.managerHost ?? Object.freeze({ downloads: { request: async (q: import('../host/manager-download-protocol.mjs').DownloadRequest) => {
      if (location.hostname !== '127.0.0.1' || location.protocol !== 'http:') throw new Error('Download host unavailable');
      const response = await fetch('/manager-download', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q), signal: AbortSignal.timeout(10000) });
      if (!response.ok || !response.body) throw new Error('Download host unavailable');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try { for (;;) { const result = await reader.read(); if (result.done) break; bytes += result.value.byteLength; if (bytes > 2048) throw new Error('Download response refused'); chunks.push(result.value); } } finally { await reader.cancel().catch(() => {}); }
      const raw = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } }, driveAuth: browserDrive, contract_version: 1 as const, kind: 'browser' as const, transport: 'not-configured' as const,
    ordinaryExport: async (request: import('../host/ordinary-export-protocol.mjs').ExportRequest|null) => {
      if(location.hostname!=='127.0.0.1'||location.protocol!=='http:')throw Error('Ordinary export helper unavailable');
      const pending=fetch('/manager-ordinary-export',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(14000)});request=null;const response=await pending;
      if(!response.ok||!response.body)throw Error('Ordinary export unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      try{for(;;){const value=await reader.read();if(value.done)break;bytes+=value.value.byteLength;if(bytes>8192)throw Error('Export response refused');chunks.push(value.value);}}finally{await reader.cancel().catch(()=>{});}
      const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw)) as ExportResult;
    },
    researchSettings: async (request: import('../host/research-settings-protocol.mjs').ResearchSettingsRequest|null) => {
      if(location.hostname!=='127.0.0.1'||location.protocol!=='http:')throw Error('Research settings helper unavailable');
      const pending=fetch('/manager-research-settings',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(14000)});request=null;const response=await pending;
      if(!response.ok||!response.body)throw Error('Research settings unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      let complete=false;try{for(;;){const value=await reader.read();if(value.done){complete=true;break;}bytes+=value.value.byteLength;if(bytes>8192)throw Error('Research response refused');chunks.push(value.value);}}finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
      const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw)) as ResearchSettingsResult;
    },
    memorySettings: async (request: import('../host/memory-settings-protocol.mjs').MemorySettingsRequest|null) => {
      if(location.hostname!=='127.0.0.1'||location.protocol!=='http:')throw Error('Memory settings helper unavailable');
      const pending=fetch('/manager-memory-settings',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(14000)});request=null;const response=await pending;
      if(!response.ok||!response.body)throw Error('Memory settings unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      let complete=false;try{for(;;){const value=await reader.read();if(value.done){complete=true;break;}bytes+=value.value.byteLength;if(bytes>8192)throw Error('Memory response refused');chunks.push(value.value);}}finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
      const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw)) as MemorySettingsResult;
    },
    handwritingRecords: async (request: HandwritingRequest|null) => {
      if(location.hostname!=='127.0.0.1'||location.protocol!=='http:')throw Error('Archive operation helper unavailable');
      const pending=fetch('/manager-handwriting-records',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(14000)});request=null;const response=await pending;
      if(!response.ok||!response.body)throw Error('Archive operation unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      let complete=false;try{for(;;){const value=await reader.read();if(value.done){complete=true;break;}bytes+=value.value.byteLength;if(bytes>270336)throw Error('Archive operation response refused');chunks.push(value.value);}}finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
      const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}return parseHandwritingJson(raw) as HandwritingResult;
    },
    selectedArchive: async (request: ArchiveRequest|null) => {
      if(location.hostname!=='127.0.0.1'||location.protocol!=='http:')throw Error('Archive operation helper unavailable');
      const pending=fetch('/manager-selected-archive',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(14000)});request=null;const response=await pending;
      if(!response.ok||!response.body)throw Error('Archive operation unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      let complete=false;try{for(;;){const value=await reader.read();if(value.done){complete=true;break;}bytes+=value.value.byteLength;if(bytes>8192)throw Error('Archive operation response refused');chunks.push(value.value);}}finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
      const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}return parseArchiveJson(raw) as ArchiveResult;
    },
    ordinaryRestore: async (request: import('../host/ordinary-restore-protocol.mjs').RestoreRequest|null) => {
      if(location.hostname!=='127.0.0.1'||location.protocol!=='http:')throw Error('Ordinary restore helper unavailable');
      const pending=fetch('/manager-ordinary-restore',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(14000)});request=null;const response=await pending;
      if(!response.ok||!response.body)throw Error('Ordinary restore unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      let complete=false;try{for(;;){const value=await reader.read();if(value.done){complete=true;break;}bytes+=value.value.byteLength;if(bytes>8192)throw Error('Ordinary restore response refused');chunks.push(value.value);}}finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
      const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}return parseRestoreJson(raw) as RestoreResult;
    },
    conversationManagement: async (request: import('../host/conversation-management-protocol.mjs').ManagementRequest|null) => {
      if(location.hostname!=='127.0.0.1'||location.protocol!=='http:')throw Error('Conversation management helper unavailable');
      const pending=fetch('/manager-conversation-management',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(14000)});request=null;const response=await pending;
      if(!response.ok||!response.body)throw Error('Conversation management unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      let complete=false;try{for(;;){const value=await reader.read();if(value.done){complete=true;break;}bytes+=value.value.byteLength;if(bytes>8192)throw Error('Conversation management response refused');chunks.push(value.value);}}finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
      const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}return parseManagementJson(raw) as ManagementResult;
    },
    sourceCacheCleanup: async (request: import('../host/source-cache-cleanup-protocol.mjs').CleanupRequest|null) => {
      if(location.hostname!=='127.0.0.1'||location.protocol!=='http:')throw Error('Cache cleanup helper unavailable');
      const pending=fetch('/manager-source-cache-cleanup',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(14000)});request=null;const response=await pending;
      if(!response.ok||!response.body)throw Error('Cache cleanup unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      let complete=false;try{for(;;){const value=await reader.read();if(value.done){complete=true;break;}bytes+=value.value.byteLength;if(bytes>8192)throw Error('Cache cleanup response refused');chunks.push(value.value);}}finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
      const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw)) as CleanupResult;
    },
    inspectConversations: async (request: import('../host/conversation-inventory-protocol.mjs').ConversationRequest|null) => {
      if(location.hostname!=='127.0.0.1'||location.protocol!=='http:')throw Error('Conversation inventory helper unavailable');
      const pending=fetch('/manager-conversation-inventory',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(14000)});request=null;const response=await pending;
      if(!response.ok||!response.body)throw Error('Conversation inventory unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      let complete=false;try{for(;;){const value=await reader.read();if(value.done){complete=true;break;}bytes+=value.value.byteLength;if(bytes>8192)throw Error('Conversation inventory response refused');chunks.push(value.value);}}finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
      const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw)) as ConversationResult;
    },
    inspectSourceCache: async (request: import('../host/source-cache-inventory-protocol.mjs').SourceCacheRequest|null) => {
      if(location.hostname!=='127.0.0.1'||location.protocol!=='http:')throw Error('Source cache inventory helper unavailable');
      const pending=fetch('/manager-source-cache-inventory',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(14000)});request=null;const response=await pending;
      if(!response.ok||!response.body)throw Error('Source cache inventory unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      let complete=false;try{for(;;){const value=await reader.read();if(value.done){complete=true;break;}bytes+=value.value.byteLength;if(bytes>8192)throw Error('Source cache inventory response refused');chunks.push(value.value);}}finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
      const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw)) as SourceCacheResult;
    },
    modelCredential: async (request: import('../host/model-credential-protocol.mjs').ModelCredentialRequest|null) => {
      if(location.hostname!=='127.0.0.1'||location.protocol!=='http:')throw Error('Model credential helper unavailable');
      const pending=fetch('/manager-model-credential',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(14000)});request=null;const response=await pending;
      if(!response.ok||!response.body)throw Error('Model credential unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      let complete=false;try{for(;;){const value=await reader.read();if(value.done){complete=true;break;}bytes+=value.value.byteLength;if(bytes>8192)throw Error('Model credential response refused');chunks.push(value.value);}}finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
      const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw)) as ModelCredentialResult;
    },
    credentialReference: async (request: import('../host/credential-reference-protocol.mjs').CredentialReferenceRequest|null) => {
      if(location.hostname!=='127.0.0.1'||location.protocol!=='http:')throw Error('Credential reference helper unavailable');
      const pending=fetch('/manager-credential-reference',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(14000)});request=null;const response=await pending;
      if(!response.ok||!response.body)throw Error('Credential reference unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      let complete=false;try{for(;;){const value=await reader.read();if(value.done){complete=true;break;}bytes+=value.value.byteLength;if(bytes>8192)throw Error('Credential reference response refused');chunks.push(value.value);}}finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
      const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw)) as CredentialReferenceResult;
    },
    modelSettings: async (request: import('../host/model-settings-protocol.mjs').ModelSettingsRequest|null) => {
      if(location.hostname!=='127.0.0.1'||location.protocol!=='http:')throw Error('Model settings helper unavailable');
      const pending=fetch('/manager-model-settings',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(14000)});request=null;const response=await pending;
      if(!response.ok||!response.body)throw Error('Model settings unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      try{for(;;){const value=await reader.read();if(value.done)break;bytes+=value.value.byteLength;if(bytes>8192)throw Error('Model response refused');chunks.push(value.value);}}finally{await reader.cancel().catch(()=>{});}
      const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw)) as ModelSettingsResult;
    },
    productSettings: async (request: import('../host/product-settings-protocol.mjs').ProductSettingsRequest) => {
      if(location.hostname!=='127.0.0.1'||location.protocol!=='http:')throw Error('Product settings helper unavailable');
      const response=await fetch('/manager-product-settings',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(14000)});
      if(!response.ok||!response.body)throw Error('Product settings unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      try{for(;;){const value=await reader.read();if(value.done)break;bytes+=value.value.byteLength;if(bytes>8192)throw Error('Product settings response refused');chunks.push(value.value);}}finally{await reader.cancel().catch(()=>{});}
      const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)) as ProductSettingsResult;
    },
    basicSettings: async (request: import('../host/basic-settings-protocol.mjs').BasicSettingsRequest) => {
      if(location.hostname!=='127.0.0.1'||location.protocol!=='http:')throw Error('Basic settings helper unavailable');
      const response=await fetch('/manager-basic-settings',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(14000)});
      if(!response.ok||!response.body)throw Error('Basic settings unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      try{for(;;){const value=await reader.read();if(value.done)break;bytes+=value.value.byteLength;if(bytes>8192)throw Error('Basic settings response refused');chunks.push(value.value);}}finally{await reader.cancel().catch(()=>{});}
      const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)) as BasicSettingsResult;
    },
    memoryForget: async (request: import('../host/memory-forget-protocol.mjs').ForgetRequest) => {
      if (location.hostname !== '127.0.0.1' || location.protocol !== 'http:') throw new Error('Memory forget helper unavailable');
      const response = await fetch('/manager-memory-forget', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(14000) });
      if (!response.ok || !response.body) throw new Error('Memory forget unavailable');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try { for (;;) { const value = await reader.read(); if (value.done) break; bytes += value.value.byteLength; if (bytes > 65536) throw new Error('Memory forget response refused'); chunks.push(value.value); } } finally { await reader.cancel().catch(() => {}); }
      const raw = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as ForgetResult;
    },
    inspectMemory: async (request: import('../host/memory-inspection.mjs').MemoryInspectionRequest) => {
      if (location.hostname !== '127.0.0.1' || location.protocol !== 'http:') throw new Error('Memory inspection helper unavailable');
      const response = await fetch('/manager-memory-inspection', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(14000) });
      if (!response.ok || !response.body) throw new Error('Memory inspection unavailable');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try { for (;;) { const value = await reader.read(); if (value.done) break; bytes += value.value.byteLength; if (bytes > 270336) throw new Error('Memory inspection response refused'); chunks.push(value.value); } } finally { await reader.cancel().catch(() => {}); }
      const raw = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as MemoryInspectionResult;
    },
    inspectSavedConfiguration: async (request: import('../host/saved-configuration.mjs').SavedConfigurationRequest) => {
      if(location.hostname!=='127.0.0.1'||location.protocol!=='http:')throw Error('Saved configuration helper unavailable');
      const response=await fetch('/manager-saved-configuration',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(14000)});
      if(!response.ok||!response.body)throw Error('Saved configuration unavailable');
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      try{for(;;){const value=await reader.read();if(value.done)break;bytes+=value.value.byteLength;if(bytes>32768)throw Error('Saved configuration response refused');chunks.push(value.value);}}finally{await reader.cancel().catch(()=>{});}
      const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)) as SavedConfigurationResult;
    },
    inspectSavedMode: async (request: import('../host/saved-mode.mjs').SavedModeRequest) => {
      if (location.hostname !== '127.0.0.1' || location.protocol !== 'http:') throw new Error('Saved mode helper unavailable');
      const response = await fetch('/manager-saved-mode', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(14000) });
      if (!response.ok || !response.body) throw new Error('Saved mode unavailable');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try { for (;;) { const value = await reader.read(); if (value.done) break; bytes += value.value.byteLength; if (bytes > 16384) throw new Error('Saved mode response refused'); chunks.push(value.value); } } finally { await reader.cancel().catch(() => {}); }
      const raw = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as SavedModeResult;
    },
    memoryQuery: async (request: import('../host/memory-query.mjs').MemoryRequest) => {
      if (location.hostname !== '127.0.0.1' || location.protocol !== 'http:') throw new Error('Memory query helper unavailable');
      const response = await fetch('/manager-memory-query', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(14000) });
      if (!response.ok || !response.body) throw new Error('Memory query unavailable');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try { for (;;) { const value = await reader.read(); if (value.done) break; bytes += value.value.byteLength; if (bytes > 139264) throw new Error('Memory query response refused'); chunks.push(value.value); } } finally { await reader.cancel().catch(() => {}); }
      const raw = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as MemoryResult;
    },
    personalization: async (request: PersonalizationRequest) => {
      if (location.hostname !== '127.0.0.1' || location.protocol !== 'http:') throw new Error('Personalization helper unavailable');
      const response = await fetch('/manager-personalization', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(14000) });
      if (!response.ok) throw new Error('Personalization unavailable');
      return await response.json() as PersonalizationResult;
    },
    inspectRuntime: () => helper('inspect-runtime') as Promise<RuntimeResult>,
    inspectOwned: () => helper('inspect-owned') as Promise<InspectionResult>,
    observe: () => helper('observe') as Promise<ObservationResult>, cancel: () => helper('cancel') as Promise<ObservationResult> });
}
