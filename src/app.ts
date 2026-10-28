import {ConversationManagementController} from './conversation-management';
import type {ManagementRetained} from '../host/conversation-management-protocol.mjs';
import {ConversationInventoryController} from './conversation-inventory';
import {SourceCacheCleanupController} from './source-cache-cleanup';
import type {CleanupRetained} from '../host/source-cache-cleanup-protocol.mjs';
import {SourceCacheInventoryController} from './source-cache-inventory';
import {ModelCredentialController} from './model-credential';
import type {ModelCredentialRetained} from '../host/model-credential-protocol.mjs';
import {CredentialReferenceController} from './credential-reference';
import type {CredentialRetained} from '../host/credential-reference-protocol.mjs';
import {MemorySettingsController} from './memory-settings';
import type {MemoryKey as MemorySettingKey,MemoryRetained as MemorySettingsRetained} from '../host/memory-settings-protocol.mjs';
import {ResearchSettingsController} from './research-settings';
import type {ResearchRetained} from '../host/research-settings-protocol.mjs';
import {OrdinaryExportController} from './ordinary-export';
import type {ExportRetained} from '../host/ordinary-export-protocol.mjs';
import { ModelSettingsController } from './model-settings';
import type { ModelKey,ModelRetained } from '../host/model-settings-protocol.mjs';
import { BasicSettingsController,basicRows } from './basic-settings';
import type { BasicKey,BasicRetained } from '../host/basic-settings-protocol.mjs';
import { SavedConfigurationController,savedConfigurationRows } from './saved-configuration';
import { MemoryForgetController } from './memory-forget';
import { MemoryInspectionController } from './memory-inspection';
import type { MemoryKey } from '../host/memory-inspection.mjs';
import { MemoryController } from './memory-query';
import { SavedModeController } from './saved-mode';
import { validMemoryText } from '../host/memory-query.mjs';
import { Component, ChangeDetectionStrategy, OnDestroy, signal, computed } from '@angular/core';
import { currentHost, unsupportedDrive } from './host';
import { DriveController } from './drive-auth';
import { unavailableDrive as unsupportedDriveState } from '../host/drive-protocol.mjs';
import { ConnectionController, CONNECTION_LABELS } from './observation';
import { PersonalizationController, validText, editText, rawOffset } from './personalization';
import type { PersonalizationOperation } from '../host/personalization.mjs';
import { DownloadController } from './manager-downloads';
import { RuntimeIdentityController } from './runtime-identity';
import { OwnedDataController } from './owned-data';
import { resolveDeviceProfile } from './device-profile';
import buildInfo from './build-info.json';
import { INSTALL_BLOCKERS, ReleaseController } from './releases';

@Component({
  selector: 'app-root', standalone: true, templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnDestroy {
  readonly host = currentHost();
  readonly drive = signal(unsupportedDriveState());
  readonly driveConsent = signal<string | null>(null);
  private readonly driveController = new DriveController(this.host.driveAuth ?? unsupportedDrive, (state, url) => { this.drive.set(state); this.driveConsent.set(url); });
  readonly driveLabels: Record<string, string> = {
    unconfigured: 'Google Drive setup required', disconnected: 'Not signed in', connecting: 'Waiting for Google sign-in…', cached: 'Saved account — connection not checked',
    connected: 'Google Drive connected', checking: 'Checking Google Drive…', cancelled: 'Sign-in or check cancelled', expired: 'Sign-in expired', denied: 'Sign-in declined',
    'authorization-failed': 'Sign-in or account check failed', unavailable: 'Google Drive connection unavailable', revoking: 'Removing Google access…', 'revocation-unconfirmed': 'Google access removal could not be confirmed',
  };
  private readonly downloadController = new DownloadController(this.host.downloads ?? { request: async () => { throw new Error('Download unavailable'); } }, (state, unknown) => { this.download.set(state); this.downloadUnknown.set(unknown); });
  readonly download = signal(this.downloadController.state);
  readonly downloadUnknown = signal(false);
  readonly downloadLabels = { unconfigured: 'Download setup required', idle: 'Ready to download', downloading: 'Downloading and checking release files…', cancelling: 'Cancelling download…', complete: 'Download checked at completion', cancelled: 'Download cancelled', failed: 'Download could not be verified' };
  readonly version = buildInfo.version;
  readonly officialBuild = buildInfo.official;
  readonly connectionLabels = CONNECTION_LABELS;
  private readonly ownedController = new OwnedDataController(state => this.owned.set(state));
  readonly owned = signal(this.ownedController.state);
  readonly personalizationText = signal('');
  readonly personalizationEnabled = signal(false);
  private readonly personalizationController = new PersonalizationController(state => { this.personalization.set(state); if (state.report?.personalization) { this.personalizationText.set(state.report.personalization.text); this.personalizationEnabled.set(state.report.personalization.enabled); } });
  readonly personalization = signal(this.personalizationController.state);
  readonly personalizationValid = computed(() => validText(this.personalizationText()));
  readonly personalizationBytes = computed(() => new TextEncoder().encode(this.personalizationText()).length);
  readonly memoryText = signal('');
  private readonly memoryController = new MemoryController(state => this.memory.set(state));
  readonly memory = signal(this.memoryController.state);
  readonly memoryTextValid = computed(() => validMemoryText(this.memoryText()));
  readonly memoryData = computed(() => { const data = this.memory().report?.data; return data && 'query_status' in data ? data : null; });
  private readonly exportController=new OrdinaryExportController(state=>this.archiveExport.set(state),()=>{document.querySelectorAll<HTMLTextAreaElement>('#archive-export-destination').forEach(field=>{field.value='';});});
  readonly archiveExport=signal(this.exportController.state);
  private readonly cleanupController=new SourceCacheCleanupController(state=>this.cacheCleanup.set(state),()=>{document.querySelectorAll<HTMLInputElement|HTMLSelectElement>('#cache-cleanup-document,#cache-cleanup-choice').forEach(field=>{field.value='';});});
  readonly cacheCleanup=signal(this.cleanupController.state);
  private readonly cacheController=new SourceCacheInventoryController(state=>this.cacheInventory.set(state));
  readonly cacheInventory=signal(this.cacheController.state);
  private readonly managementController=new ConversationManagementController(state=>this.conversationManagement.set(state),()=>{document.querySelectorAll<HTMLSelectElement>('#conversation-management-choice').forEach(field=>{field.value='';});});
  readonly conversationManagement=signal(this.managementController.state);
  private readonly conversationController=new ConversationInventoryController(state=>this.conversationInventory.set(state));
  readonly conversationInventory=signal(this.conversationController.state);
  private readonly fileCredentialController=new ModelCredentialController(state=>this.fileCredential.set(state),()=>{document.querySelectorAll<HTMLTextAreaElement>('#model-credential-value').forEach(field=>{field.value='';});});
  readonly fileCredential=signal(this.fileCredentialController.state);
  readonly fileCredentialCanSave=computed(()=>this.fileCredential().view?.state==='ready'&&!this.fileCredential().busy&&!this.fileCredentialPeerBusy()&&this.fileCredential().valid&&this.fileCredential().retained.length<8);
  private readonly credentialController=new CredentialReferenceController(state=>this.credential.set(state),()=>{document.querySelectorAll<HTMLTextAreaElement>('#credential-reference-name').forEach(field=>{field.value='';});});
  readonly credential=signal(this.credentialController.state);
  readonly credentialCanSave=computed(()=>this.credential().view?.state==='ready'&&!this.fileCredential().busy&&!this.credential().busy&&!this.credentialPeerBusy()&&this.credential().valid&&this.credential().retained.length<8);
  private readonly memorySettingsController=new MemorySettingsController(state=>this.memorySettings.set(state),key=>{if(!key||key==='profile')document.querySelectorAll<HTMLTextAreaElement>('#memory-settings-profile').forEach(field=>{field.value='';});});
  readonly memorySettings=signal(this.memorySettingsController.state);
  readonly memorySettingsCanSave=computed(()=>this.memorySettings().view?.state==='ready'&&!this.fileCredential().busy&&!this.credential().busy&&!this.memorySettings().busy&&!this.memorySettingsPeerBusy()&&this.memorySettings().valid&&this.memorySettings().retained.length<8);
  private readonly modelController=new ModelSettingsController(state=>this.model.set(state),key=>{document.querySelectorAll<HTMLTextAreaElement>(key?'#model-replacement-'+key:'[id^="model-replacement-"]').forEach(field=>{field.value='';});});
  readonly model=signal(this.modelController.state);
  readonly modelCanSave=computed(()=>this.model().view?.state==='ready'&&!this.model().busy&&this.model().valid&&this.model().retained.length<8);
  readonly modelRows=computed(()=>{const current=this.model().view?.current;if(!current)return [];return (['model','base_url'] as ModelKey[]).map(key=>({key,label:key==='model'?'Model':'Endpoint',originLabel:{default:'No saved override',declared:'Saved value present','declared-null':'Explicitly empty'}[current[key].origin],action:this.model().actions[key]}));});
  private readonly basicController=new BasicSettingsController(state=>this.basic.set(state));
  readonly basic=signal(this.basicController.state);
  readonly basicRows=computed(()=>basicRows(this.basic().view?.current??null,this.basic().draft));
  readonly basicCanSave=computed(()=>this.basic().view?.state==='ready'&&!this.basic().busy&&Object.keys(this.basic().changes).length>0&&this.basic().retained.length<8);
  private readonly forgetController = new MemoryForgetController(state => this.forget.set(state));
  readonly forget = signal(this.forgetController.state);
  readonly forgetHead = computed(() => { const heads = this.memoryInspection().view?.heads; return heads?.length === 1 && heads[0].kind === 'value' ? heads[0] : null; });
  private readonly memoryInspectionController = new MemoryInspectionController(state => this.memoryInspection.set(state));
  readonly memoryInspection = signal(this.memoryInspectionController.state);
  private readonly savedConfigurationController=new SavedConfigurationController(state=>this.savedConfiguration.set(state));
  readonly savedConfiguration=signal(this.savedConfigurationController.state);
  readonly configurationGroups=computed(()=>{
    const rows=savedConfigurationRows(this.savedConfiguration().view);
    return [
      {label:'Model and basic settings',rows:rows.filter(row=>!row.key.includes('.'))},
      {label:'Paths',rows:rows.filter(row=>row.key.startsWith('paths.'))},
      {label:'Memory and sync',rows:rows.filter(row=>row.key.startsWith('memory.')||row.key.startsWith('sync.'))},
      {label:'Personalization',rows:rows.filter(row=>row.key.startsWith('personalization.'))},
    ];
  });
  readonly configurationGaps=computed(()=>{const labels:Record<string,string>={'reader-enablement':'Reader enablement','writer-enablement':'Writer enablement','retrieval-policy':'Retrieval policy','research-policy':'Research policy','mem-destination':'Mem destination','handwriting-settings':'Handwriting settings'};return (this.savedConfiguration().view?.snapshot?.unsupported??[]).map(key=>({key,label:labels[key]}));});
  private readonly savedModeController = new SavedModeController(state => this.savedMode.set(state));
  readonly savedMode = signal(this.savedModeController.state);
  private readonly runtimeController = new RuntimeIdentityController(state => this.runtimeIdentity.set(state));
  readonly runtimeIdentity = signal(this.runtimeController.state);
  private readonly researchController=new ResearchSettingsController(state=>this.research.set(state),()=>{if(typeof document!=='undefined'){const input=document.getElementById('research-choice') as HTMLSelectElement|null;if(input)input.value='keep';}});
  readonly research=signal(this.researchController.state);
  private readonly connectionController = new ConnectionController(this.host, state => { this.savedConfigurationController.clear(); this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear(); this.memoryInspectionController.clear(); this.savedModeController.clear(); this.memoryController.clear(); this.ownedController.clear(); this.personalizationController.clear(); this.runtimeController.clear(); this.connection.set(state); });
  readonly connection = signal(this.connectionController.state);
  readonly profile = computed(() => resolveDeviceProfile(this.connection()));
  readonly storageCategories = [
    { key: 'structural', label: 'Storage structure', consequence: 'Identity and manifests keep stored history consistent.' },
    { key: 'record-metadata', label: 'Record metadata', consequence: 'Conversation, source and association records preserve history.' },
    { key: 'media-object', label: 'Media objects', consequence: 'Referenced source evidence may be shared by several categories.' },
    { key: 'unclassified-object', label: 'Unclassified objects', consequence: 'No safe deletion or current-use conclusion is available.' },
    { key: 'retained-generation', label: 'Retained generations', consequence: 'Older retained history can be needed for recovery.' },
    { key: 'cache', label: 'Caches and indexes', consequence: 'Inspection requires the matching cache owner; source history stays separate.' },
    { key: 'diagnostics', label: 'Owned diagnostics', consequence: 'External transient diagnostics are excluded from this inventory.' },
    { key: 'staging', label: 'Staging', consequence: 'Interrupted or in-progress files require separate maintenance checks.' },
  ];
  readonly domainCategories = [
    { key: 'conversation', label: 'Conversations', consequence: 'Durable conversation metadata and history.' },
    { key: 'source', label: 'Source evidence', consequence: 'Buddy-owned source-image references; original tablet documents are excluded.' },
    { key: 'export-association', label: 'Export associations', consequence: 'Local associations do not prove native page readiness or delete exported notes.' },
    { key: 'subject-memory', label: 'Subject memory', consequence: 'Stored memory records; presence does not establish current selected membership.' },
    { key: 'handwriting', label: 'Handwriting learning', consequence: 'Buddy-owned learning records; native ink remains separate.' },
  ];
  readonly feedbackDomainCategories = [...this.domainCategories,
    { key: 'unassociated-feedback', label: 'Unassociated feedback history', consequence: 'Historical observations only; counts do not establish display, current operation state or cleanup permission.' },
  ];
  issues() { return Object.entries(this.owned().report?.issues ?? {}).map(([code, count]) => ({ label: code.replaceAll('-', ' '), count })); }
  bytes(value: number) { return `${new Intl.NumberFormat().format(value)} bytes`; }
  readonly blockers = INSTALL_BLOCKERS;
  private readonly releases = new ReleaseController(this.preferenceStorage(), state => this.release.set(state));
  readonly release = signal(this.releases.state);
  private readonly managerReleases = new ReleaseController(null, state => this.managerRelease.set(state), undefined, 'manager');
  readonly managerRelease = signal(this.managerReleases.state);
  private readonly clearFileOnHidden=()=>{if(document.visibilityState==='hidden'){this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();}};
  private readonly clearModelOnPageHide=()=>{this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();};
  constructor() { if(this.host.modelCredential)void this.fileCredentialController.retained({modelCredential:q=>this.host.modelCredential!(q)}); if(this.host.credentialReference)void this.credentialController.retained({credentialReference:q=>this.host.credentialReference!(q)}); if(this.host.memorySettings)void this.memorySettingsController.retained({memorySettings:q=>this.host.memorySettings!(q)}); if(this.host.researchSettings)void this.researchController.retained({researchSettings:q=>this.host.researchSettings!(q)}); window.addEventListener('pagehide',this.clearModelOnPageHide); document.addEventListener('visibilitychange',this.clearFileOnHidden); if(this.host.ordinaryExport)void this.exportController.retained({ordinaryExport:q=>this.host.ordinaryExport!(q)}); if(this.host.modelSettings)void this.modelController.retained({modelSettings:q=>this.host.modelSettings!(q)}); if(this.host.basicSettings)void this.basicController.retained({basicSettings:q=>this.host.basicSettings!(q)}); if (this.host.memoryForget) void this.forgetController.run({ memoryForget: request => this.host.memoryForget!(request) }, { action:'status' }); this.releases.start(); this.managerReleases.start(); void this.driveController.load(); void this.downloadController.request({action: 'status'}); }
  private preferenceStorage(): Storage | null { try { return window.localStorage; } catch { return null; } }
  connectTablet() { void this.connectionController.connect(); }
  disconnectTablet() { this.connectionController.disconnect(); }
  editMemory(event: Event) { this.memoryText.set((event.target as HTMLTextAreaElement).value); }
  async searchMemory() {if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy))return;
    this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear(); this.memoryInspectionController.clear();
    const tablet = this.connection().observation;
    if (!tablet || !this.profile().memoryQueryProbe || !this.host.memoryQuery || !this.memoryTextValid()) return;
    await this.memoryController.search({ memoryQuery: request => this.host.memoryQuery!(request) }, tablet, this.memoryText());
  }
  async cancelMemory() { this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear(); this.memoryInspectionController.clear(); this.memoryController.clear('Search cancelled'); try { await this.host.cancel(); } catch { /* Already cleared; no late result is accepted. */ } }
  async inspectMemory(key: MemoryKey) {if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy))return;
    this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear();
    const tablet = this.connection().observation;
    const matches = this.memoryData()?.context.facts;
    if (!tablet || !this.profile().memoryInspectionProbe || !this.host.inspectMemory || this.memoryInspection().busy || !matches?.some(m => JSON.stringify(m.fact.key) === JSON.stringify(key))) return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || this.memoryData()?.context.facts !== matches) return;
    await this.memoryInspectionController.inspect({ inspectMemory: request => this.host.inspectMemory!(request) }, tablet, key);
  }
  async cancelMemoryInspection() { this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear(); this.memoryInspectionController.clear('Memory inspection cancelled'); try { await this.host.cancel(); } catch { /* Already invalidated. */ } }
  managementCurrentState(){const state=this.conversationManagement().view?.report?.current_state;return state==='live-original'?'Original conversation state still matches the preview':state==='desired-tombstones'?'Prepared logical removal is the current conversation state':state==='changed'?'Conversation state has changed since the preview':'Current state unverified';}
  managementHistoricalState(){const status=this.conversationManagement().view?.report?.status;return status==='acknowledged'?'Original logical-removal receipt verified':['ready','prepared'].includes(status??'')?'No removal has been confirmed':'Original historical outcome remains unproven';}
  managementPeerBusy(){return this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy||this.fileCredential().busy||this.credential().busy||this.memorySettings().busy||this.research().busy||this.model().busy||this.basic().busy||this.forget().busy||this.archiveExport().busy;}
  canManageConversation(action:'inspect'|'prepare'|'confirm'){if(!this.host.conversationManagement||!this.profile().inspection||this.conversationManagement().busy||this.managementPeerBusy())return false;const v=this.conversationManagement().view;return action==='inspect'?this.conversationInventory().view?.complete===true&&!!this.conversationInventory().view?.candidates?.includes(this.conversationManagement().selection)&&this.managementController.valid()&&this.conversationManagement().retained.length<8:action==='prepare'?v?.state==='inspected':v?.state==='ready';}
  async selectManagement(event:Event){if(this.managementPeerBusy()||this.conversationManagement().busy)return;const value=(event.target as HTMLSelectElement).value;const selected=this.conversationInventory().view?.complete&&this.conversationInventory().view?.candidates?.includes(value)?value:'';if(this.conversationManagement().view&&this.host.conversationManagement)await this.managementController.stop({conversationManagement:q=>this.host.conversationManagement!(q)});this.managementController.select(selected);}
  private clearManagementPeers(){this.conversationController.clear();this.cleanupController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear();this.forgetController.clear();this.exportController.clear();this.savedConfigurationController.clear();}
  async manageConversation(action:'inspect'|'prepare'|'confirm'){const tablet=this.connection().observation;if(!tablet||!this.canManageConversation(action))return;this.clearManagementPeers();await this.managementController[action]({conversationManagement:q=>this.host.conversationManagement!(q)},tablet,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet&&this.profile().inspection;});}
  canCheckManagement(row:ManagementRetained){const t=this.connection().observation;return !!this.host.conversationManagement&&this.managementController.canCheck(row)&&!this.conversationManagement().busy&&!this.managementPeerBusy()&&!!t&&t.connection_id===row.connection_id&&t.boot_id===row.boot_id;}
  async checkManagement(row:ManagementRetained){const t=this.connection().observation;if(!t||!this.canCheckManagement(row))return;this.clearManagementPeers();await this.managementController.status({conversationManagement:q=>this.host.conversationManagement!(q)},t,row,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;});}
  async stopManagement(){if(this.managementPeerBusy())return;if(this.host.conversationManagement)await this.managementController.stop({conversationManagement:q=>this.host.conversationManagement!(q)});}
  async showManagementOriginals(){if(this.host.conversationManagement)await this.managementController.retained({conversationManagement:q=>this.host.conversationManagement!(q)});}
  cleanupPeerBusy(){return this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.fileCredential().busy||this.credential().busy||this.memorySettings().busy||this.research().busy||this.model().busy||this.basic().busy||this.forget().busy||this.archiveExport().busy;}
  canPrepareCleanup(){return !!this.host.sourceCacheCleanup&&this.profile().inspection&&!this.cacheCleanup().busy&&!this.cleanupPeerBusy()&&this.cleanupController.valid()&&this.cacheCleanup().retained.length<8;}
  canConfirmCleanup(){return !!this.host.sourceCacheCleanup&&this.profile().inspection&&!this.cacheCleanup().busy&&!this.cleanupPeerBusy()&&this.cacheCleanup().view?.state==='ready';}
  selectCleanup(event:Event){this.cleanupController.select((event.target as HTMLInputElement).value);}
  private clearCleanupPeers(){this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear();this.forgetController.clear();this.exportController.clear();this.savedConfigurationController.clear();}
  async prepareCleanup(){const tablet=this.connection().observation;if(!tablet||!this.canPrepareCleanup())return;this.clearCleanupPeers();await this.cleanupController.prepare({sourceCacheCleanup:q=>this.host.sourceCacheCleanup!(q)},tablet,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet&&this.profile().inspection;});}
  async confirmCleanup(){const tablet=this.connection().observation;if(!tablet||!this.canConfirmCleanup())return;this.clearCleanupPeers();await this.cleanupController.confirm({sourceCacheCleanup:q=>this.host.sourceCacheCleanup!(q)},tablet,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet&&this.profile().inspection;});}
  canCheckCleanup(row:CleanupRetained){const t=this.connection().observation;return !!this.host.sourceCacheCleanup&&this.cleanupController.canCheck(row)&&!this.cacheCleanup().busy&&!this.cleanupPeerBusy()&&!!t&&t.connection_id===row.connection_id&&t.boot_id===row.boot_id;}
  async checkCleanup(row:CleanupRetained){const tablet=this.connection().observation;if(!tablet||!this.canCheckCleanup(row))return;this.clearCleanupPeers();await this.cleanupController.status({sourceCacheCleanup:q=>this.host.sourceCacheCleanup!(q)},tablet,row,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet&&this.profile().inspection;});}
  async stopCleanup(){if(this.cleanupPeerBusy())return;if(this.host.sourceCacheCleanup)await this.cleanupController.stop({sourceCacheCleanup:q=>this.host.sourceCacheCleanup!(q)});else this.cleanupController.clear();}
  conversationPeerBusy(){return this.conversationManagement().busy||this.cacheInventory().busy||this.cacheCleanup().busy||this.fileCredential().busy||this.credential().busy||this.memorySettings().busy||this.research().busy||this.model().busy||this.basic().busy||this.forget().busy||this.archiveExport().busy;}
  canInspectConversations(){return !!this.host.inspectConversations&&this.profile().inspection&&!this.conversationInventory().busy&&!this.conversationPeerBusy();}
  private clearConversationPeers(){this.managementController.clear();this.cleanupController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear();this.forgetController.clear();this.exportController.clear();this.savedConfigurationController.clear();}
  async inspectConversations(){const tablet=this.connection().observation;if(!tablet||!this.canInspectConversations())return;this.clearConversationPeers();await this.conversationController.inspect({inspectConversations:q=>this.host.inspectConversations!(q)},tablet,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet&&this.profile().inspection;});}
  stopConversations(){this.conversationController.stop();}
  sourceCachePeerBusy(){return this.conversationManagement().busy||this.conversationInventory().busy||this.cacheCleanup().busy||this.fileCredential().busy||this.credential().busy||this.memorySettings().busy||this.research().busy||this.model().busy||this.basic().busy||this.forget().busy||this.archiveExport().busy;}
  canInspectSourceCache(){return !!this.host.inspectSourceCache&&this.profile().inspection&&!(this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)&&!this.sourceCachePeerBusy();}
  private clearSourceCachePeers(){this.managementController.clear();this.conversationController.clear();this.cleanupController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear();this.forgetController.clear();this.exportController.clear();this.savedConfigurationController.clear();}
  async inspectSourceCache(){const tablet=this.connection().observation;if(!tablet||!this.canInspectSourceCache())return;this.clearSourceCachePeers();await this.cacheController.inspect({inspectSourceCache:q=>this.host.inspectSourceCache!(q)},tablet,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet&&this.profile().inspection;});}
  stopSourceCache(){this.cacheController.stop();}
  fileCredentialPeerBusy(){return (this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.credential().busy||this.research().busy||this.memorySettings().busy||this.model().busy||this.basic().busy||this.forget().busy||this.archiveExport().busy;}
  canBeginFileCredential(){return !!this.host.modelCredential&&this.profile().savedConfigurationProbe&&!this.fileCredential().busy&&!this.fileCredentialPeerBusy()&&this.fileCredential().retained.length<8;}
  private clearFileCredentialPeers(){this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.credentialController.clear();this.researchController.clear();this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear();this.forgetController.clear();this.savedConfigurationController.clear();}
  async beginFileCredential(){const tablet=this.connection().observation;if(!tablet||!this.canBeginFileCredential())return;this.clearFileCredentialPeers();await this.fileCredentialController.begin({modelCredential:q=>this.host.modelCredential!(q)},tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});}
  fileCredentialAction(event:Event){this.fileCredentialController.action('model_credential',(event.target as HTMLSelectElement).value);}
  fileCredentialText(){return this.fileCredentialController.text('model_credential');}
  beforeFileCredential(event:Event){const e=event as InputEvent,f=event.target as HTMLTextAreaElement;this.fileCredentialController.beforeInput('model_credential',f.selectionStart,f.selectionEnd,e.inputType,e.data);}
  inputFileCredential(event:Event){const f=event.target as HTMLTextAreaElement;this.fileCredentialController.input('model_credential',f.value);f.value=this.fileCredentialText();}
  pasteFileCredential(event:Event){const e=event as ClipboardEvent;if(!e.clipboardData)return;const f=event.target as HTMLTextAreaElement,text=e.clipboardData.getData('text/plain'),start=f.selectionStart;e.preventDefault();this.fileCredentialController.paste('model_credential',start,f.selectionEnd,text);f.value=this.fileCredentialText();const caret=Math.min(f.value.length,start+text.replace(/\r\n?/g,'\n').length);f.setSelectionRange(caret,caret);}
  async saveFileCredential(){const tablet=this.connection().observation;if(!tablet||!this.host.modelCredential||this.fileCredentialPeerBusy())return;this.clearFileCredentialPeers();await this.fileCredentialController.save({modelCredential:q=>this.host.modelCredential!(q)},tablet);}
  canCheckFileCredential(record:ModelCredentialRetained){const t=this.connection().observation;return record.status_available&&!this.fileCredential().busy&&!this.fileCredentialPeerBusy()&&!!t&&t.connection_id===record.connection_id&&t.boot_id===record.boot_id;}
  async checkFileCredential(record:ModelCredentialRetained){const tablet=this.connection().observation;if(!tablet||!record.status_available||!this.host.modelCredential||this.fileCredentialPeerBusy())return;this.clearFileCredentialPeers();await this.fileCredentialController.status({modelCredential:q=>this.host.modelCredential!(q)},record,tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});}
  async stopFileCredential(){if(this.fileCredentialPeerBusy())return;if(this.host.modelCredential)await this.fileCredentialController.stop({modelCredential:q=>this.host.modelCredential!(q)});}
  credentialPeerBusy(){return (this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.research().busy||this.memorySettings().busy||this.model().busy||this.basic().busy||this.forget().busy||this.archiveExport().busy;}
  canBeginCredential(){return !!this.host.credentialReference&&this.profile().savedConfigurationProbe&&!this.fileCredential().busy&&!this.credential().busy&&!this.credentialPeerBusy();}
  private clearCredentialPeers(){this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.researchController.clear();this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear();this.forgetController.clear();this.savedConfigurationController.clear();}
  async beginCredential(){const tablet=this.connection().observation;if(!tablet||!this.canBeginCredential())return;this.clearCredentialPeers();await this.credentialController.begin({credentialReference:q=>this.host.credentialReference!(q)},tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});}
  credentialAction(event:Event){this.credentialController.action('model_credential',(event.target as HTMLSelectElement).value);}
  credentialText(){return this.credentialController.text('model_credential');}
  beforeCredential(event:Event){const e=event as InputEvent,f=event.target as HTMLTextAreaElement;this.credentialController.beforeInput('model_credential',f.selectionStart,f.selectionEnd,e.inputType,e.data);}
  inputCredential(event:Event){const f=event.target as HTMLTextAreaElement;this.credentialController.input('model_credential',f.value);f.value=this.credentialText();}
  pasteCredential(event:Event){const e=event as ClipboardEvent;if(!e.clipboardData)return;const f=event.target as HTMLTextAreaElement,text=e.clipboardData.getData('text/plain'),start=f.selectionStart;e.preventDefault();this.credentialController.paste('model_credential',start,f.selectionEnd,text);f.value=this.credentialText();const caret=Math.min(f.value.length,start+text.replace(/\r\n?/g,'\n').length);f.setSelectionRange(caret,caret);}
  async saveCredential(){const tablet=this.connection().observation;if(!tablet||!this.host.credentialReference||this.credentialPeerBusy())return;this.clearCredentialPeers();await this.credentialController.save({credentialReference:q=>this.host.credentialReference!(q)},tablet);}
  canCheckCredential(record:CredentialRetained){const t=this.connection().observation;return !this.fileCredential().busy&&!this.credential().busy&&!this.credentialPeerBusy()&&!!t&&t.connection_id===record.connection_id&&t.boot_id===record.boot_id;}
  async checkCredential(record:CredentialRetained){const tablet=this.connection().observation;if(!tablet||!this.host.credentialReference||this.credentialPeerBusy())return;this.clearCredentialPeers();await this.credentialController.status({credentialReference:q=>this.host.credentialReference!(q)},record,tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});}
  async stopCredential(){if(this.credentialPeerBusy())return;if(this.host.credentialReference)await this.credentialController.stop({credentialReference:q=>this.host.credentialReference!(q)});}
  private memorySettingsPeerBusy(){return (this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.model().busy||this.basic().busy||this.forget().busy||this.archiveExport().busy;}
  async beginSavedMemory(){
    const tablet=this.connection().observation;if(!tablet||!this.profile().savedConfigurationProbe||!this.host.memorySettings||this.memorySettings().busy||this.memorySettingsPeerBusy())return;
    this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.researchController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear();this.forgetController.clear();this.savedConfigurationController.clear();
    await this.memorySettingsController.begin({memorySettings:q=>this.host.memorySettings!(q)},tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});
  }
  memorySettingAction(key:MemorySettingKey,event:Event){this.memorySettingsController.action(key,(event.target as HTMLSelectElement).value);}
  memoryEnabled(event:Event){this.memorySettingsController.enabled((event.target as HTMLSelectElement).value==='true');}
  memoryProfileText(){return this.memorySettingsController.text('profile');}
  beforeMemoryProfile(event:Event){const e=event as InputEvent,f=event.target as HTMLTextAreaElement;this.memorySettingsController.beforeInput('profile',f.selectionStart,f.selectionEnd,e.inputType,e.data);}
  inputMemoryProfile(event:Event){const f=event.target as HTMLTextAreaElement;this.memorySettingsController.input('profile',f.value);f.value=this.memoryProfileText();}
  pasteMemoryProfile(event:Event){const e=event as ClipboardEvent;if(!e.clipboardData)return;const f=event.target as HTMLTextAreaElement,text=e.clipboardData.getData('text/plain'),start=f.selectionStart;e.preventDefault();this.memorySettingsController.paste('profile',start,f.selectionEnd,text);f.value=this.memoryProfileText();const caret=Math.min(f.value.length,start+text.replace(/\r\n?/g,'\n').length);f.setSelectionRange(caret,caret);}
  async saveMemorySettings(){if(this.memorySettingsPeerBusy())return;this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.researchController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear();this.forgetController.clear();this.savedConfigurationController.clear();const tablet=this.connection().observation;if(tablet&&this.host.memorySettings)await this.memorySettingsController.save({memorySettings:q=>this.host.memorySettings!(q)},tablet);}
  async checkMemorySettings(record:MemorySettingsRetained){const tablet=this.connection().observation;if(!tablet||!this.host.memorySettings||this.memorySettingsPeerBusy())return;this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.researchController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear();this.forgetController.clear();await this.memorySettingsController.status({memorySettings:q=>this.host.memorySettings!(q)},record,tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});}
  canCheckMemorySettings(record:MemorySettingsRetained){const t=this.connection().observation;return !this.memorySettings().busy&&!this.memorySettingsPeerBusy()&&!!t&&t.connection_id===record.connection_id&&t.boot_id===record.boot_id;}
  async stopMemorySettings(){if(this.memorySettingsPeerBusy())return;if(this.host.memorySettings)await this.memorySettingsController.stop({memorySettings:q=>this.host.memorySettings!(q)});}
  exportText(){return this.exportController.text();}
  canEditExport(){return !!this.host.ordinaryExport&&this.profile().savedConfigurationProbe&&!this.research().busy&&!this.fileCredential().busy&&!this.credential().busy&&!this.memorySettings().busy&&!this.archiveExport().busy&&!this.model().busy&&!this.basic().busy&&!this.forget().busy;}
  beginExportEdit(){if(this.canEditExport())void this.connectionController.pause();}
  beforeExportInput(event:Event){const e=event as InputEvent,field=event.target as HTMLTextAreaElement;this.exportController.beforeInput(field.selectionStart,field.selectionEnd,e.inputType,e.data);}
  inputExport(event:Event){const field=event.target as HTMLTextAreaElement;this.exportController.input(field.value);field.value=this.exportController.text();}
  pasteExport(event:Event){const e=event as ClipboardEvent;if(!e.clipboardData)return;const field=event.target as HTMLTextAreaElement,text=e.clipboardData.getData('text/plain'),start=field.selectionStart;e.preventDefault();this.exportController.paste(start,field.selectionEnd,text);field.value=this.exportController.text();const caret=Math.min(field.value.length,start+text.replace(/\r\n?/g,'\n').length);field.setSelectionRange(caret,caret);}
  async prepareExport(){if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy)return;const tablet=this.connection().observation;if(!tablet||!this.profile().savedConfigurationProbe||!this.host.ordinaryExport||this.archiveExport().busy)return;this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear();this.forgetController.clear();this.savedConfigurationController.clear();await this.exportController.prepare({ordinaryExport:q=>this.host.ordinaryExport!(q)},tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});}
  async confirmExport(){if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy)return;const tablet=this.connection().observation;if(tablet&&this.host.ordinaryExport){this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear();this.forgetController.clear();await this.exportController.confirm({ordinaryExport:q=>this.host.ordinaryExport!(q)},tablet);}}
  async checkExport(record:ExportRetained){if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy)return;const tablet=this.connection().observation;if(tablet&&this.host.ordinaryExport&&tablet.connection_id===record.connection_id&&tablet.boot_id===record.boot_id){this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear();this.forgetController.clear();await this.exportController.status({ordinaryExport:q=>this.host.ordinaryExport!(q)},tablet,record.reference,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});}}
  canCheckExport(record:ExportRetained){const tablet=this.connection().observation;return !this.archiveExport().busy&&!!tablet&&tablet.connection_id===record.connection_id&&tablet.boot_id===record.boot_id;}
  async stopExport(){if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy)return;if(this.host.ordinaryExport)await this.exportController.stop({ordinaryExport:q=>this.host.ordinaryExport!(q)});}
  private researchPeerBusy(){return (this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.memorySettings().busy||this.model().busy||this.basic().busy||this.forget().busy||this.archiveExport().busy;}
  canBeginResearch(){return !!this.host.researchSettings&&this.profile().savedConfigurationProbe&&!this.research().busy&&!this.researchPeerBusy();}
  private clearResearchPeers(){this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear();this.forgetController.clear();this.savedConfigurationController.clear();}
  private async pauseResearch(tablet:import('./observation').TabletObservation){await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;}
  async beginResearch(){const tablet=this.connection().observation;if(!tablet||!this.canBeginResearch())return;this.clearResearchPeers();await this.researchController.begin({researchSettings:q=>this.host.researchSettings!(q)},tablet,()=>this.pauseResearch(tablet));}
  researchChoice(event:Event){this.researchController.choose((event.target as HTMLSelectElement).value);}
  async saveResearch(){const tablet=this.connection().observation;if(!tablet||!this.host.researchSettings||this.researchPeerBusy())return;this.clearResearchPeers();await this.researchController.save({researchSettings:q=>this.host.researchSettings!(q)},tablet);}
  researchTarget(record:ResearchRetained){const tablet=this.connection().observation;return tablet?.connection_id===record.connection_id&&tablet.boot_id===record.boot_id;}
  async checkResearch(record:ResearchRetained){const tablet=this.connection().observation;if(!tablet||!this.host.researchSettings||this.researchPeerBusy())return;this.clearResearchPeers();await this.researchController.status({researchSettings:q=>this.host.researchSettings!(q)},record,tablet,()=>this.pauseResearch(tablet));}
  async stopResearch(){if(this.researchPeerBusy())return;if(this.host.researchSettings)await this.researchController.stop({researchSettings:q=>this.host.researchSettings!(q)});}
  async beginModel(){if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy)return;this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();
    const tablet=this.connection().observation;if(!tablet||!this.profile().savedConfigurationProbe||!this.host.modelSettings||this.model().busy)return;
    this.exportController.clear();this.basicController.clear();this.forgetController.clear();this.savedConfigurationController.clear();
    await this.modelController.begin({modelSettings:q=>this.host.modelSettings!(q)},tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});
  }
  modelAction(key:ModelKey,event:Event){this.modelController.action(key,(event.target as HTMLSelectElement).value);}
  modelText(key:ModelKey){return this.modelController.text(key);}
  beforeModelInput(key:ModelKey,event:Event){const e=event as InputEvent,field=event.target as HTMLTextAreaElement;this.modelController.beforeInput(key,field.selectionStart,field.selectionEnd,e.inputType,e.data);}
  inputModel(key:ModelKey,event:Event){const field=event.target as HTMLTextAreaElement;this.modelController.input(key,field.value);field.value=this.modelController.text(key);}
  pasteModel(key:ModelKey,event:ClipboardEvent){
    if(!event.clipboardData)return;event.preventDefault();const field=event.target as HTMLTextAreaElement,start=field.selectionStart,end=field.selectionEnd,text=event.clipboardData.getData('text/plain');
    this.modelController.paste(key,start,end,text);field.value=this.modelController.text(key);const caret=Math.min(field.value.length,start+text.replace(/\r\n?/g,'\n').length);field.setSelectionRange(caret,caret);
  }
  async saveModel(){if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy)return;this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();const tablet=this.connection().observation;if(tablet&&this.host.modelSettings){this.exportController.clear();this.basicController.clear();this.forgetController.clear();this.savedConfigurationController.clear();await this.modelController.save({modelSettings:q=>this.host.modelSettings!(q)},tablet);}}
  modelTarget(record:ModelRetained){const tablet=this.connection().observation;return tablet?.connection_id===record.connection_id&&tablet.boot_id===record.boot_id;}
  async checkModel(record:ModelRetained){if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy)return;this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();const tablet=this.connection().observation;if(tablet&&this.host.modelSettings){this.exportController.clear();this.basicController.clear();this.forgetController.clear();await this.modelController.status({modelSettings:q=>this.host.modelSettings!(q)},record,tablet);}}
  async stopModel(){if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy)return;if(this.host.modelSettings)await this.modelController.stop({modelSettings:q=>this.host.modelSettings!(q)},()=>this.connectionController.pause());}
  async beginBasic(){if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy)return;
    const tablet=this.connection().observation;if(!tablet||!this.profile().savedConfigurationProbe||!this.host.basicSettings||this.basic().busy)return;
    this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.forgetController.clear();this.savedConfigurationController.clear();
    await this.basicController.begin({basicSettings:q=>this.host.basicSettings!(q)},tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});
  }
  editBasic(key:BasicKey,event:Event){this.basicController.edit(key,(event.target as HTMLSelectElement).value);}
  clearBasic(key:BasicKey){this.basicController.edit(key,'');}
  async saveBasic(){if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy)return;const tablet=this.connection().observation;if(tablet&&this.host.basicSettings){this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.forgetController.clear();this.savedConfigurationController.clear();await this.basicController.save({basicSettings:q=>this.host.basicSettings!(q)},tablet);}}
  basicTarget(record:BasicRetained){const tablet=this.connection().observation;return tablet?.connection_id===record.connection_id&&tablet.boot_id===record.boot_id;}
  async checkBasic(record:BasicRetained){if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy)return;const tablet=this.connection().observation;if(tablet&&this.host.basicSettings){this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.forgetController.clear();await this.basicController.status({basicSettings:q=>this.host.basicSettings!(q)},record,tablet);}}
  async stopBasic(){if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy)return;if(this.host.basicSettings)await this.basicController.stop({basicSettings:q=>this.host.basicSettings!(q)},()=>this.connectionController.pause());}
  async prepareForget() {if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy)return;
    const tablet = this.connection().observation, head = this.forgetHead();
    if (!tablet || !head?.fact || !this.host.memoryForget || this.forget().busy) return;
    this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear();await this.connectionController.pause();
    if (this.connection().observation !== tablet || this.forgetHead() !== head) return;
    await this.forgetController.run({ memoryForget: request => this.host.memoryForget!(request) }, { action:'prepare', connection_id:tablet.connection_id, boot_id:tablet.boot_id, key:head.fact.key });
  }
  async forgetAction(action:'confirm'|'receipt'|'status') {if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy)return;
    if (!this.host.memoryForget) return;
    const reference = this.forget().reference;
    if (action !== 'status' && !reference) return;
    this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();if(action!=='status'){this.exportController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear();}
    if (action === 'confirm') this.memoryInspectionController.clear('Current data unverified after possible confirmation dispatch');
    await this.forgetController.run({ memoryForget: request => this.host.memoryForget!(request) }, action === 'status' ? { action } : { action, reference:reference! });
  }
  async stopForget() {if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy)return;
    await this.forgetController.stop(this.host.memoryForget ? { memoryForget: request => this.host.memoryForget!(request) } : null, () => this.host.cancel());
  }
  async inspectSavedConfiguration(){if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy))return;
    const tablet=this.connection().observation;
    if(!tablet||!this.profile().savedConfigurationProbe||!this.host.inspectSavedConfiguration||this.savedConfiguration().busy)return;
    this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear();
    await this.savedConfigurationController.inspect({inspectSavedConfiguration:q=>this.host.inspectSavedConfiguration!(q)},tablet,async()=>{
      await this.connectionController.pause();
      return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;
    });
  }
  async cancelSavedConfiguration(){
    this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear();
    await this.savedConfigurationController.cancel(()=>this.connectionController.pause());
  }
  async inspectSavedMode() {if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy))return;
    this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear();
    const tablet = this.connection().observation;
    if (!tablet || !this.profile().savedModeProbe || !this.host.inspectSavedMode || this.savedMode().busy) return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || !this.profile().savedModeProbe) return;
    await this.savedModeController.inspect({ inspectSavedMode: request => this.host.inspectSavedMode!(request) }, tablet);
  }
  async cancelSavedMode() { this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear(); this.savedModeController.clear('Saved mode inspection cancelled'); try { await this.host.cancel(); } catch { /* Pending view is already invalidated. */ } }
  async inspectOwned() {if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy))return;
    this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear();
    const tablet = this.connection().observation;
    if (!this.profile().inspection || !tablet || this.owned().status === 'Inspecting owned data…') return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || !this.profile().inspection) return;
    await this.ownedController.inspect(this.host, tablet);
  }
  async inspectRuntime() {if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy))return;
    this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear();
    const tablet = this.connection().observation;
    if (!tablet || !this.profile().runtimeIdentityProbe || !this.host.inspectRuntime || this.runtimeIdentity().status === 'Reading binary version…') return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || !this.profile().runtimeIdentityProbe) return;
    await this.runtimeController.inspect({ inspectRuntime: () => this.host.inspectRuntime!() }, tablet);
  }
  async personalize(operation: PersonalizationOperation) {if((this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.cacheCleanup().busy))return;
    this.exportController.clear();this.cleanupController.clear();this.managementController.clear();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear();
    const tablet = this.connection().observation;
    if (!tablet || !this.profile().personalizationProbe || !this.host.personalization || this.personalization().busy) return;
    const submittedText = this.personalizationText(), submittedEnabled = this.personalizationEnabled();
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || !this.profile().personalizationProbe) return;
    await this.personalizationController.run({ personalization: request => this.host.personalization!(request) }, tablet, operation, submittedText, submittedEnabled);
  }
  editPersonalization(event: Event) { this.personalizationText.set(editText(this.personalizationText(), (event.target as HTMLTextAreaElement).value)); }
  pastePersonalization(event: ClipboardEvent) {
    if (!event.clipboardData) return;
    const field = event.target as HTMLTextAreaElement, original = this.personalizationText();
    const next = original.slice(0, rawOffset(original, field.selectionStart)) + event.clipboardData.getData('text/plain') + original.slice(rawOffset(original, field.selectionEnd));
    event.preventDefault(); this.personalizationText.set(next); field.value = next.replace(/\r\n?/g, '\n');
  }
  togglePersonalization(event: Event) { this.personalizationEnabled.set((event.target as HTMLInputElement).checked); }
  signInDrive() { void this.driveController.begin(); }
  checkDrive() { void this.driveController.action('check'); }
  cancelDrive() { void this.driveController.action('cancel'); }
  disconnectDrive() { void this.driveController.action('disconnect'); }
  revokeDrive() {
    const account = this.drive().account?.label;
    if (account && window.confirm(`Remove Google access for ${account}? This may stop Drive access in other copies of this Google app. Your backups will not be deleted.`)) void this.driveController.action('revoke');
  }
  refresh() { void this.releases.refresh(); }
  downloadManager() { const state = this.managerRelease(); if (state.status === 'ready' && !state.stale && state.candidate?.assetsPublished) void this.downloadController.request({action:'start',tag:state.candidate.tag}); }
  cancelManagerDownload() { const id = this.download().operation_id; if (id) void this.downloadController.request({action:'cancel',operation_id:id}); }
  checkManagerDownload() { void this.downloadController.request({action:'status'}); }
  refreshManager() { void this.managerReleases.refresh(); }
  chooseOfficial() { this.releases.chooseOfficial(); }
  ngOnDestroy() { document.removeEventListener('visibilitychange',this.clearFileOnHidden); window.removeEventListener('pagehide',this.clearModelOnPageHide); this.savedConfigurationController.clear(); this.downloadController.dispose(); this.driveController.dispose(); this.releases.dispose(); this.managerReleases.dispose(); this.connectionController.dispose(); this.exportController.clear();this.cleanupController.dispose();this.managementController.dispose();this.conversationController.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear(); this.memoryInspectionController.clear(); this.savedModeController.clear(); this.memoryController.clear(); this.ownedController.clear(); this.personalizationController.clear(); this.runtimeController.clear(); }
}
