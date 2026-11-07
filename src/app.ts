import {SharedPreferenceController, sharedPatch, target as sharedTarget, type SharedPreferenceState} from './shared-preferences';
import type {RetainedPreference} from '../host/shared-preferences-protocol.mjs';
import {PortableController} from './portable-configuration';
import type {PortableRetained,PortableOrigins} from '../host/portable-configuration-protocol.mjs';
import {NotebookArchiveController,archiveAttemptMessage as notebookAttemptMessage} from './notebook-archive';
import type {ArchiveRetained as NotebookRetained} from '../host/notebook-archive-protocol.mjs';
import {StorageInitializationController} from './storage-initialization';
import type {StorageInitializationRetained} from '../host/storage-initialization-protocol.mjs';
import {OwnedV3Controller,ownedV3Rows,exactCount} from './owned-data-v3';
import {LocalModeChoiceController} from './local-mode-choice';
import type {LocalModeRetained} from '../host/local-mode-choice-protocol.mjs';
import { ProductSettingsController,productRows } from './product-settings';
import type { ProductKey,ProductRetained } from '../host/product-settings-protocol.mjs';
import{HandwritingRecordsController,handwritingAttemptMessage}from'./handwriting-records';
import type{HandwritingRequest,HandwritingRetained}from'../host/handwriting-records-protocol.mjs';
import {SelectedArchiveController,archiveAttemptMessage} from './selected-archive';
import type {ArchiveRetained} from '../host/selected-archive-protocol.mjs';
import {OrdinaryRestoreController,restoreAttemptMessage,type RestoreFamily} from './ordinary-restore';
import type {RestoreRetained} from '../host/ordinary-restore-protocol.mjs';
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
  private readonly sharedPreferenceController = new SharedPreferenceController(state => this.sharedPreferences.set(state));
  readonly sharedPreferences = signal(this.sharedPreferenceController.state);
  readonly sharedLabels: Record<SharedPreferenceState['state'], string> = {
    idle: 'Shared preferences have not been inspected.', ready: 'Shared preference snapshot read.',
    joining: 'The shared group is still joining.', unresolved: 'The shared preference selection is unresolved.',
    invalidated: 'The shared preference snapshot expired or changed. Inspect again.',
    capacity: 'Check unresolved original edits before starting another.',
    'no-change': 'The shared declarations already match.', 'local-selected': 'Saved locally. Shared publication is pending.',
    applied: 'The original shared revision was verified as applied.',
    superseded: 'The original edit was superseded by the shared winner.',
    unsupported: 'This Buddy build or storage mode does not support shared preferences.',
    unavailable: 'Shared preferences are unavailable.', busy: 'Buddy data is busy. Inspect again when ownership is available.',
    conflict: 'The shared preferences changed. Inspect again before editing.',
    'not-dispatched': 'The shared edit was refused before publication.',
    'invalid-input': 'Nothing was sent. Use supported preferences and keep the prompt at or below 16 KiB (16,384 UTF-8 bytes).',
    unknown: 'The edit outcome is unknown. Check the original edit.',
  };
  private readonly portableController=new PortableController(state=>this.portable.set(state),()=>{document.querySelectorAll<HTMLInputElement>('#portable-file').forEach(f=>{f.value='';});});
  readonly portable=signal(this.portableController.state);
  private readonly clearPortable=()=>{this.portableController.clear();this.sharedPreferenceController.clear();};
  readonly portableLabels:Record<string,string>={product_settings:'Reader/Writer preferences',personalization:'Personalization',research_policy:'Research preference',absent:'No saved preference',declared:'Saved preference','declared-null':'Explicitly empty'};
  readonly portableRows=computed(()=>{const s=this.portable().view?.summary;return s?.kind==='import'?s.changed_settings.map(key=>({key,label:this.portableLabels[key],before:this.portableLabels[s.before?.[key as keyof PortableOrigins]??'absent'],after:this.portableLabels[s.after?.[key as keyof PortableOrigins]??'absent']})):[];});
  private readonly exportController=new OrdinaryExportController(state=>this.archiveExport.set(state),()=>{document.querySelectorAll<HTMLTextAreaElement>('#archive-export-destination').forEach(field=>{field.value='';});});
  readonly archiveExport=signal(this.exportController.state);
  private readonly cleanupController=new SourceCacheCleanupController(state=>this.cacheCleanup.set(state),()=>{document.querySelectorAll<HTMLInputElement|HTMLSelectElement>('#cache-cleanup-document,#cache-cleanup-choice').forEach(field=>{field.value='';});});
  readonly cacheCleanup=signal(this.cleanupController.state);
  private readonly storageInitializationController=new StorageInitializationController(state=>this.storageInitialization.set(state));
  readonly storageInitialization=signal(this.storageInitializationController.state);
  private readonly ownedV3Controller=new OwnedV3Controller(state=>this.ownedV3.set(state));
  readonly ownedV3=signal(this.ownedV3Controller.state);
  readonly ownedV3Rows=computed(()=>ownedV3Rows(this.ownedV3().view));
  readonly exactCount=exactCount;
  readonly ownedV3Issues=computed(()=>Object.entries(this.ownedV3().view?.issues??{}).map(([key,count])=>({key,count:exactCount(count)})));
  private readonly cacheController=new SourceCacheInventoryController(state=>this.cacheInventory.set(state));
  readonly cacheInventory=signal(this.cacheController.state);
  private readonly handwritingController=new HandwritingRecordsController(state=>this.handwritingRecords.set(state),()=>{document.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('[data-handwriting-private]').forEach(field=>{field.value='';});});
  readonly handwritingRecords=signal(this.handwritingController.state);
  private readonly selectedController=new SelectedArchiveController(state=>this.selectedArchive.set(state),()=>{document.querySelectorAll<HTMLTextAreaElement>('#selected-archive-path').forEach(field=>{field.value='';});});
  private readonly notebookController=new NotebookArchiveController(state=>this.notebookArchive.set(state),()=>{document.querySelectorAll<HTMLTextAreaElement>('#notebook-archive-path').forEach(field=>{field.value='';});});
  readonly notebookArchive=signal(this.notebookController.state);
  readonly selectedArchive=signal(this.selectedController.state);
  private readonly restoreController=new OrdinaryRestoreController(state=>this.ordinaryRestore.set(state),()=>{document.querySelectorAll<HTMLTextAreaElement>('#ordinary-restore-source').forEach(field=>{field.value='';});});
  readonly ordinaryRestore=signal(this.restoreController.state);
  private readonly notebookRestoreController=new OrdinaryRestoreController(state=>this.notebookRestore.set(state),()=>{document.querySelectorAll<HTMLTextAreaElement>('#notebook-restore-source').forEach(field=>{field.value='';});},undefined,undefined,'notebook');
  readonly notebookRestore=signal(this.notebookRestoreController.state);
  readonly restoreFamilies=['notebook','legacy'] as const;
  restoreId(family:RestoreFamily){return family==='notebook'?'notebook-restore':'ordinary-restore';}
  restoreState(family:RestoreFamily){return family==='notebook'?this.notebookRestore():this.ordinaryRestore();}
  private restoreControllerFor(family:RestoreFamily){return family==='notebook'?this.notebookRestoreController:this.restoreController;}
  private restoreCapability(family:RestoreFamily){return family==='notebook'?this.host.notebookRestore:this.host.ordinaryRestore;}
  settingsBusy(){return this.sharedPreferences().busy||this.portable().busy||this.localModeChoice().busy||this.product().busy;}
  restoresBusy(){return this.notebookRestore().busy||this.ordinaryRestore().busy;}
  private clearRestores(){this.notebookRestoreController.clear();this.restoreController.clear();}
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
  private readonly productController=new ProductSettingsController(state=>this.product.set(state),()=>{document.querySelectorAll<HTMLSelectElement>('[id^="product-"]').forEach(field=>{field.value="";});});
  readonly product=signal(this.productController.state);
  readonly productRows=computed(()=>productRows(this.product().view?.current??null,this.product().draft));
  readonly productCanSave=computed(()=>this.product().view?.state==='ready'&&!this.settingsBusy()&&!this.productPeerBusy()&&Object.keys(this.product().changes).length>0&&this.product().retained.length<8);
  private readonly basicController=new BasicSettingsController(state=>this.basic.set(state));
  readonly basic=signal(this.basicController.state);
  readonly basicRows=computed(()=>basicRows(this.basic().view?.current??null,this.basic().draft));
  readonly basicCanSave=computed(()=>this.basic().view?.state==='ready'&&!(this.settingsBusy()||this.basic().busy)&&Object.keys(this.basic().changes).length>0&&this.basic().retained.length<8);
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
  private readonly localModeController=new LocalModeChoiceController(state=>this.localModeChoice.set(state));
  readonly localModeChoice=signal(this.localModeController.state);
  private readonly savedModeController = new SavedModeController(state => this.savedMode.set(state));
  readonly savedMode = signal(this.savedModeController.state);
  private readonly runtimeController = new RuntimeIdentityController(state => this.runtimeIdentity.set(state));
  readonly runtimeIdentity = signal(this.runtimeController.state);
  private readonly researchController=new ResearchSettingsController(state=>this.research.set(state),()=>{if(typeof document!=='undefined'){const input=document.getElementById('research-choice') as HTMLSelectElement|null;if(input)input.value='keep';}});
  readonly research=signal(this.researchController.state);
  private readonly connectionController = new ConnectionController(this.host, state => { this.clearPortable();this.savedConfigurationController.clear(); this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1(); this.forgetController.clear(); this.memoryInspectionController.clear(); this.savedModeController.clear(); this.memoryController.clear(); this.ownedController.clear(); this.personalizationController.clear(); this.runtimeController.clear(); this.connection.set(state); });
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
  private readonly clearFileOnHidden=()=>{if(document.visibilityState==='hidden'){this.stopLocalModeOnLifecycle();this.localModeController.clear();this.productController.clear();this.clearSharedArchivePeers2();this.fileCredentialController.clear();}};
  private readonly clearModelOnPageHide=()=>{this.stopLocalModeOnLifecycle();this.localModeController.clear();this.productController.clear();this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.modelController.clear();};
  constructor() { if (this.host.sharedPreferences) void this.sharedPreferenceController.run(this.host.sharedPreferences, {action: 'retained'}); if(this.host.portableConfiguration)void this.portableController.retained({portableConfiguration:q=>this.host.portableConfiguration!(q)}); if(this.host.notebookRestore)void this.notebookRestoreController.retained(this.host); if(this.host.notebookArchive)void this.notebookController.retained({notebookArchive:q=>this.host.notebookArchive!(q)}); if(this.host.storageInitialization)void this.storageInitializationController.retained(this.storageInitializationAdapter()); if(this.host.localModeChoice)void this.localModeController.retained({localModeChoice:q=>this.host.localModeChoice!(q)}); if(this.host.handwritingRecords)void this.handwritingController.retained({handwritingRecords:q=>this.host.handwritingRecords!(q)}); if(this.host.selectedArchive)void this.selectedController.retained({selectedArchive:q=>this.host.selectedArchive!(q)}); if(this.host.ordinaryRestore)void this.restoreController.retained({ordinaryRestore:q=>this.host.ordinaryRestore!(q)}); if(this.host.modelCredential)void this.fileCredentialController.retained({modelCredential:q=>this.host.modelCredential!(q)}); if(this.host.credentialReference)void this.credentialController.retained({credentialReference:q=>this.host.credentialReference!(q)}); if(this.host.memorySettings)void this.memorySettingsController.retained({memorySettings:q=>this.host.memorySettings!(q)}); if(this.host.researchSettings)void this.researchController.retained({researchSettings:q=>this.host.researchSettings!(q)}); window.addEventListener('pagehide',this.clearModelOnPageHide); document.addEventListener('visibilitychange',this.clearFileOnHidden); if(this.host.ordinaryExport)void this.exportController.retained({ordinaryExport:q=>this.host.ordinaryExport!(q)}); if(this.host.modelSettings)void this.modelController.retained({modelSettings:q=>this.host.modelSettings!(q)}); if(this.host.productSettings)void this.productController.retained({productSettings:q=>this.host.productSettings!(q)}); if(this.host.basicSettings)void this.basicController.retained({basicSettings:q=>this.host.basicSettings!(q)}); if (this.host.memoryForget) void this.forgetController.run({ memoryForget: request => this.host.memoryForget!(request) }, { action:'status' }); this.releases.start(); this.managerReleases.start(); void this.driveController.load(); void this.downloadController.request({action: 'status'}); }
  private preferenceStorage(): Storage | null { try { return window.localStorage; } catch { return null; } }
  connectTablet() { void this.connectionController.connect(); }
  disconnectTablet() { this.connectionController.disconnect(); }
  editMemory(event: Event) { this.memoryText.set((event.target as HTMLTextAreaElement).value); }
  async searchMemory() {if(this.archiveMaintenanceBusy2())return;
    this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1(); this.forgetController.clear(); this.memoryInspectionController.clear();
    const tablet = this.connection().observation;
    if (!tablet || !this.profile().memoryQueryProbe || !this.host.memoryQuery || !this.memoryTextValid()) return;
    await this.memoryController.search({ memoryQuery: request => this.host.memoryQuery!(request) }, tablet, this.memoryText());
  }
  async cancelMemory() { this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1(); this.forgetController.clear(); this.memoryInspectionController.clear(); this.memoryController.clear('Search cancelled'); try { await this.host.cancel(); } catch { /* Already cleared; no late result is accepted. */ } }
  async inspectMemory(key: MemoryKey) {if(this.archiveMaintenanceBusy2())return;
    this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1(); this.forgetController.clear();
    const tablet = this.connection().observation;
    const matches = this.memoryData()?.context.facts;
    if (!tablet || !this.profile().memoryInspectionProbe || !this.host.inspectMemory || this.memoryInspection().busy || !matches?.some(m => JSON.stringify(m.fact.key) === JSON.stringify(key))) return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || this.memoryData()?.context.facts !== matches) return;
    await this.memoryInspectionController.inspect({ inspectMemory: request => this.host.inspectMemory!(request) }, tablet, key);
  }
  async cancelMemoryInspection() { this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1(); this.forgetController.clear(); this.memoryInspectionController.clear('Memory inspection cancelled'); try { await this.host.cancel(); } catch { /* Already invalidated. */ } }
  private clearArchivePeers(){this.clearPortable();this.notebookController.clear();this.selectedController.clear();this.clearRestores();this.managementController.clear();this.conversationController.clear();this.storageInitializationController.clear();this.ownedV3Controller.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();}
  archiveMaintenanceBusy1(){return ((((this.settingsBusy()||this.handwritingRecords().busy)||this.archiveBusy())||this.restoresBusy())||this.conversationManagement().busy||this.conversationInventory().busy||(this.cacheInventory().busy||(this.ownedV3().busy||this.storageInitialization().busy))||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy;}
  archiveMaintenanceBusy2(){return ((((this.settingsBusy()||this.handwritingRecords().busy)||this.archiveBusy())||this.restoresBusy())||this.conversationManagement().busy||this.conversationInventory().busy||(this.cacheInventory().busy||(this.ownedV3().busy||this.storageInitialization().busy))||this.cacheCleanup().busy);}
  archiveMaintenanceBusy3(){return (((this.handwritingRecords().busy||this.archiveBusy())||this.restoresBusy())||this.conversationManagement().busy||this.conversationInventory().busy||(this.cacheInventory().busy||(this.ownedV3().busy||this.storageInitialization().busy))||this.cacheCleanup().busy)||this.fileCredential().busy||this.credential().busy||this.research().busy||this.memorySettings().busy;}
  private clearSharedArchivePeers1(){this.clearPortable();this.modelController.clear();this.localModeController.clear();this.productController.clear();this.basicController.clear();}
  private clearSharedArchivePeers2(){this.clearPortable();this.cleanupController.clear();this.handwritingController.clear();this.notebookController.clear();this.selectedController.clear();this.clearRestores();this.managementController.clear();this.conversationController.clear();this.storageInitializationController.clear();this.ownedV3Controller.clear();this.cacheController.clear();}
  private clearSharedArchivePeers3(){this.clearPortable();this.localModeController.clear();this.productController.clear();this.basicController.clear();this.forgetController.clear();}
  archiveBusy(){return this.selectedArchive().busy||this.notebookArchive().busy;}
  archiveAttemptMessage=archiveAttemptMessage;
  selectedPeerBusy(){return this.notebookArchive().busy||this.localModeChoice().busy||(this.settingsBusy()||this.handwritingRecords().busy)||this.restoresBusy()||this.conversationManagement().busy||this.conversationInventory().busy||(this.cacheInventory().busy||(this.ownedV3().busy||this.storageInitialization().busy))||this.cacheCleanup().busy||this.fileCredential().busy||this.credential().busy||this.memorySettings().busy||this.research().busy||this.model().busy||(this.settingsBusy()||this.basic().busy)||this.forget().busy||this.archiveExport().busy;}
  handwritingAttemptMessage=handwritingAttemptMessage;
  handwritingPeerBusy(){return this.localModeChoice().busy||this.archiveBusy()||this.restoresBusy()||this.conversationManagement().busy||this.conversationInventory().busy||(this.cacheInventory().busy||(this.ownedV3().busy||this.storageInitialization().busy))||this.cacheCleanup().busy||this.fileCredential().busy||this.credential().busy||this.memorySettings().busy||this.research().busy||this.model().busy||(this.settingsBusy()||this.basic().busy)||this.forget().busy||this.archiveExport().busy;}
  handwritingAvailable(){return !!this.host.handwritingRecords&&this.profile().inspection&&!(this.settingsBusy()||this.handwritingRecords().busy)&&!this.handwritingPeerBusy();}
  handwritingText(field:'profile'|'correction'|'query'){return this.handwritingController.text(field);}
  updateHandwriting(field:'profile'|'correction'|'query',event:Event){if(!this.handwritingAvailable())return;const input=event.target as HTMLInputElement|HTMLTextAreaElement;this.handwritingController.input(field,input.value);input.value=this.handwritingController.text(field);}
  pasteHandwriting(field:'profile'|'correction'|'query',event:Event){if(!this.handwritingAvailable())return;const e=event as ClipboardEvent;if(!e.clipboardData)return;e.preventDefault();const input=event.target as HTMLInputElement|HTMLTextAreaElement;this.handwritingController.paste(field,input.selectionStart??0,input.selectionEnd??0,e.clipboardData.getData('text/plain'));input.value=this.handwritingController.text(field);}
  canQueryHandwriting(){return this.handwritingAvailable()&&this.handwritingController.valid();}
  canInspectHandwriting(){return this.handwritingAvailable()&&this.handwritingController.valid(true);}
  canPrepareHandwriting(){return this.handwritingAvailable()&&this.handwritingController.canPrepare()&&this.handwritingRecords().retained.length<8;}
  private handwritingAdapter(){return{handwritingRecords:(q:HandwritingRequest)=>this.host.handwritingRecords!(q)};}
  private clearHandwritingPeers(){this.clearPortable();this.notebookController.clear();this.selectedController.clear();this.clearRestores();this.managementController.clear();this.conversationController.clear();this.cleanupController.clear();this.storageInitializationController.clear();this.ownedV3Controller.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.clearSharedArchivePeers1();this.forgetController.clear();this.exportController.clear();this.savedConfigurationController.clear();}
  private async pauseHandwriting(t:import('./observation').TabletObservation){await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;}
  async queryHandwriting(){const t=this.connection().observation;if(!t||!this.canQueryHandwriting())return;this.clearHandwritingPeers();await this.handwritingController.query(this.handwritingAdapter(),t,()=>this.pauseHandwriting(t));}
  async inspectHandwriting(key?:{profile:string;correction:string}){const t=this.connection().observation;if(!t||!this.handwritingAvailable()||!key&&!this.canInspectHandwriting())return;this.clearHandwritingPeers();await this.handwritingController.inspect(this.handwritingAdapter(),t,()=>this.pauseHandwriting(t),key);}
  async prepareHandwriting(){const t=this.connection().observation;if(!t||!this.canPrepareHandwriting())return;this.clearHandwritingPeers();await this.handwritingController.prepare(this.handwritingAdapter(),t,()=>this.pauseHandwriting(t));}
  async confirmHandwriting(){const t=this.connection().observation;if(!t||!this.handwritingAvailable()||this.handwritingRecords().result?.state!=='prepared')return;this.clearHandwritingPeers();await this.handwritingController.confirm(this.handwritingAdapter(),t,()=>this.pauseHandwriting(t));}
  canCheckHandwriting(r:HandwritingRetained){const t=this.connection().observation;return this.handwritingAvailable()&&!!t&&r.connection_id===t.connection_id&&r.boot_id===t.boot_id&&this.handwritingController.canCheck(r);}
  async checkHandwriting(r:HandwritingRetained){const t=this.connection().observation;if(!t||!this.canCheckHandwriting(r))return;this.clearHandwritingPeers();await this.handwritingController.check(this.handwritingAdapter(),t,r,()=>this.pauseHandwriting(t));}
  async stopHandwriting(){if(!this.handwritingPeerBusy()&&this.host.handwritingRecords)await this.handwritingController.stop(this.handwritingAdapter());}
  selectedPathText(){return this.selectedController.text();}
  updateSelectedPath(event:Event){if(this.selectedPeerBusy()||((this.settingsBusy()||this.handwritingRecords().busy)||this.archiveBusy()))return;const field=event.target as HTMLTextAreaElement;this.selectedController.input(field.value);field.value=this.selectedController.text();}
  beforeSelectedPath(event:Event){if(this.selectedPeerBusy()||((this.settingsBusy()||this.handwritingRecords().busy)||this.archiveBusy()))return;const e=event as InputEvent,field=event.target as HTMLTextAreaElement;this.selectedController.beforeInput(field.selectionStart,field.selectionEnd,e.inputType,e.data);}
  pasteSelectedPath(event:Event){if(this.selectedPeerBusy()||((this.settingsBusy()||this.handwritingRecords().busy)||this.archiveBusy()))return;const e=event as ClipboardEvent;if(!e.clipboardData)return;const field=event.target as HTMLTextAreaElement,text=e.clipboardData.getData('text/plain'),start=field.selectionStart;e.preventDefault();this.selectedController.paste(start,field.selectionEnd,text);field.value=this.selectedController.text();const caret=Math.min(field.value.length,start+text.replace(/\r\n?/g,'\n').length);field.setSelectionRange(caret,caret);}
  canInspectArchive(){return !!this.host.selectedArchive&&this.profile().inspection&&!((this.settingsBusy()||this.handwritingRecords().busy)||this.archiveBusy())&&!this.selectedPeerBusy()&&this.selectedController.valid();}
  canPreviewArchive(){return this.canInspectArchive()&&this.selectedArchive().retained.length<8;}
  canConfirmArchive(){return !!this.host.selectedArchive&&this.profile().inspection&&!((this.settingsBusy()||this.handwritingRecords().busy)||this.archiveBusy())&&!this.selectedPeerBusy()&&this.selectedArchive().view?.state==='ready';}
  private clearSelectedPeers(){this.clearPortable();this.notebookController.clear();this.handwritingController.clear();this.clearRestores();this.managementController.clear();this.conversationController.clear();this.cleanupController.clear();this.storageInitializationController.clear();this.ownedV3Controller.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.clearSharedArchivePeers1();this.forgetController.clear();this.exportController.clear();this.savedConfigurationController.clear();}
  async inspectArchive(){const t=this.connection().observation;if(!t||!this.canInspectArchive())return;this.clearSelectedPeers();await this.selectedController.inspect({selectedArchive:q=>this.host.selectedArchive!(q)},t,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;});}
  async previewArchive(){const t=this.connection().observation;if(!t||!this.canPreviewArchive())return;this.clearSelectedPeers();await this.selectedController.prepare({selectedArchive:q=>this.host.selectedArchive!(q)},t,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;});}
  async confirmArchive(){const t=this.connection().observation;if(!t||!this.canConfirmArchive())return;this.clearSelectedPeers();await this.selectedController.confirm({selectedArchive:q=>this.host.selectedArchive!(q)},t,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;});}
  canCheckArchive(r:ArchiveRetained){const t=this.connection().observation;return !!this.host.selectedArchive&&!!t&&r.connection_id===t.connection_id&&r.boot_id===t.boot_id&&!((this.settingsBusy()||this.handwritingRecords().busy)||this.archiveBusy())&&!this.selectedPeerBusy()&&this.selectedController.canCheck(r);}
  async checkArchive(r:ArchiveRetained){const t=this.connection().observation;if(!t||!this.canCheckArchive(r))return;this.clearSelectedPeers();await this.selectedController.check({selectedArchive:q=>this.host.selectedArchive!(q)},t,r,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;});}
  async stopArchive(){if(this.selectedPeerBusy())return;if(this.host.selectedArchive)await this.selectedController.stop({selectedArchive:q=>this.host.selectedArchive!(q)});}
  async showArchiveOriginals(){if(this.host.selectedArchive)await this.selectedController.retained({selectedArchive:q=>this.host.selectedArchive!(q)});}
  notebookAttemptMessage=notebookAttemptMessage;
  notebookPeerBusy(){return this.selectedArchive().busy||this.localModeChoice().busy||(this.settingsBusy()||this.handwritingRecords().busy)||this.restoresBusy()||this.conversationManagement().busy||this.conversationInventory().busy||(this.cacheInventory().busy||(this.ownedV3().busy||this.storageInitialization().busy))||this.cacheCleanup().busy||this.fileCredential().busy||this.credential().busy||this.memorySettings().busy||this.research().busy||this.model().busy||(this.settingsBusy()||this.basic().busy)||this.forget().busy||this.archiveExport().busy;}
  notebookPathText(){return this.notebookController.text();}
  updateNotebookPath(event:Event){if(this.notebookPeerBusy()||this.notebookArchive().busy)return;const field=event.target as HTMLTextAreaElement;this.notebookController.input(field.value);field.value=this.notebookController.text();}
  beforeNotebookPath(event:Event){if(this.notebookPeerBusy()||this.notebookArchive().busy)return;const e=event as InputEvent,field=event.target as HTMLTextAreaElement;this.notebookController.beforeInput(field.selectionStart,field.selectionEnd,e.inputType,e.data);}
  pasteNotebookPath(event:Event){if(this.notebookPeerBusy()||this.notebookArchive().busy)return;const e=event as ClipboardEvent;if(!e.clipboardData)return;const field=event.target as HTMLTextAreaElement,text=e.clipboardData.getData('text/plain'),start=field.selectionStart;e.preventDefault();this.notebookController.paste(start,field.selectionEnd,text);field.value=this.notebookController.text();const caret=Math.min(field.value.length,start+text.replace(/\r\n?/g,'\n').length);field.setSelectionRange(caret,caret);}
  canInspectNotebookArchive(){return !!this.host.notebookArchive&&this.profile().inspection&&!this.notebookArchive().busy&&!this.notebookPeerBusy()&&this.notebookController.valid();}
  canPreviewNotebookArchive(){return this.canInspectNotebookArchive()&&this.notebookArchive().retained.length<8;}
  canConfirmNotebookArchive(){return !!this.host.notebookArchive&&this.profile().inspection&&!this.notebookArchive().busy&&!this.notebookPeerBusy()&&this.notebookArchive().view?.state==='ready';}
  private clearNotebookPeers(){this.clearPortable();this.selectedController.clear();this.handwritingController.clear();this.clearRestores();this.managementController.clear();this.conversationController.clear();this.cleanupController.clear();this.storageInitializationController.clear();this.ownedV3Controller.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.clearSharedArchivePeers1();this.forgetController.clear();this.exportController.clear();this.savedConfigurationController.clear();}
  async inspectNotebookArchive(){const t=this.connection().observation;if(!t||!this.canInspectNotebookArchive())return;this.clearNotebookPeers();await this.notebookController.inspect({notebookArchive:q=>this.host.notebookArchive!(q)},t,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;});}
  async previewNotebookArchive(){const t=this.connection().observation;if(!t||!this.canPreviewNotebookArchive())return;this.clearNotebookPeers();await this.notebookController.prepare({notebookArchive:q=>this.host.notebookArchive!(q)},t,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;});}
  async confirmNotebookArchive(){const t=this.connection().observation;if(!t||!this.canConfirmNotebookArchive())return;this.clearNotebookPeers();await this.notebookController.confirm({notebookArchive:q=>this.host.notebookArchive!(q)},t,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;});}
  canCheckNotebookArchive(r:NotebookRetained){const t=this.connection().observation;return !!this.host.notebookArchive&&!!t&&r.connection_id===t.connection_id&&r.boot_id===t.boot_id&&!this.notebookArchive().busy&&!this.notebookPeerBusy()&&this.notebookController.canCheck(r);}
  async checkNotebookArchive(r:NotebookRetained){const t=this.connection().observation;if(!t||!this.canCheckNotebookArchive(r))return;this.clearNotebookPeers();await this.notebookController.check({notebookArchive:q=>this.host.notebookArchive!(q)},t,r,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;});}
  async stopNotebookArchive(){if(this.notebookPeerBusy())return;if(this.host.notebookArchive)await this.notebookController.stop({notebookArchive:q=>this.host.notebookArchive!(q)});}
  async showNotebookArchiveOriginals(){if(this.host.notebookArchive)await this.notebookController.retained({notebookArchive:q=>this.host.notebookArchive!(q)});}
  restoreAttemptMessage=restoreAttemptMessage;
  restorePeerBusy(family:RestoreFamily='legacy'){return this.restoreState(family==='legacy'?'notebook':'legacy').busy||this.localModeChoice().busy||this.product().busy||this.handwritingRecords().busy||this.archiveBusy()||this.conversationManagement().busy||this.conversationInventory().busy||this.cacheInventory().busy||this.ownedV3().busy||this.storageInitialization().busy||this.cacheCleanup().busy||this.fileCredential().busy||this.credential().busy||this.memorySettings().busy||this.research().busy||this.model().busy||this.basic().busy||this.forget().busy||this.archiveExport().busy;}
  private restoreBusy(family:RestoreFamily){return this.restoreState(family).busy||this.restorePeerBusy(family);}
  updateRestoreSource(event:Event,family:RestoreFamily='legacy'){if(this.restoreBusy(family))return;const field=event.target as HTMLTextAreaElement;this.restoreControllerFor(family).input(field.value);field.value=this.restoreControllerFor(family).text();}
  restoreSourceText(family:RestoreFamily='legacy'){return this.restoreControllerFor(family).text();}
  beforeRestoreSource(event:Event,family:RestoreFamily='legacy'){if(this.restoreBusy(family))return;const e=event as InputEvent,field=event.target as HTMLTextAreaElement;this.restoreControllerFor(family).beforeInput(field.selectionStart,field.selectionEnd,e.inputType,e.data);}
  pasteRestoreSource(event:Event,family:RestoreFamily='legacy'){if(this.restoreBusy(family))return;const e=event as ClipboardEvent;if(!e.clipboardData)return;const field=event.target as HTMLTextAreaElement,text=e.clipboardData.getData('text/plain'),start=field.selectionStart;e.preventDefault();this.restoreControllerFor(family).paste(start,field.selectionEnd,text);field.value=this.restoreControllerFor(family).text();const caret=Math.min(field.value.length,start+text.replace(/\r\n?/g,'\n').length);field.setSelectionRange(caret,caret);}
  canPrepareRestore(family:RestoreFamily='legacy'){return !!this.restoreCapability(family)&&this.profile().inspection&&!this.restoreBusy(family)&&this.restoreControllerFor(family).valid()&&this.restoreState(family).retained.length<8;}
  canConfirmRestore(family:RestoreFamily='legacy'){return !!this.restoreCapability(family)&&this.profile().inspection&&!this.restoreBusy(family)&&this.restoreState(family).view?.state==='ready';}
  private clearRestorePeers(family:RestoreFamily='legacy'){this.clearPortable();this.restoreControllerFor(family==='legacy'?'notebook':'legacy').clear();this.handwritingController.clear();this.notebookController.clear();this.selectedController.clear();this.managementController.clear();this.conversationController.clear();this.cleanupController.clear();this.storageInitializationController.clear();this.ownedV3Controller.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.clearSharedArchivePeers1();this.forgetController.clear();this.exportController.clear();this.savedConfigurationController.clear();}
  async prepareRestore(family:RestoreFamily='legacy'){const t=this.connection().observation;if(!t||!this.canPrepareRestore(family))return;this.clearRestorePeers(family);await this.restoreControllerFor(family).prepare(this.host,t,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;});}
  async confirmRestore(family:RestoreFamily='legacy'){const t=this.connection().observation;if(!t||!this.canConfirmRestore(family))return;this.clearRestorePeers(family);await this.restoreControllerFor(family).confirm(this.host,t,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;});}
  canCheckRestore(r:RestoreRetained,family:RestoreFamily='legacy'){const t=this.connection().observation;return !!this.restoreCapability(family)&&!!t&&t.connection_id===r.connection_id&&t.boot_id===r.boot_id&&!this.restoreBusy(family)&&this.restoreControllerFor(family).canCheck(r);}
  async checkRestore(r:RestoreRetained,family:RestoreFamily='legacy'){const t=this.connection().observation;if(!t||!this.canCheckRestore(r,family))return;this.clearRestorePeers(family);await this.restoreControllerFor(family).status(this.host,t,r,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;});}
  async stopRestore(family:RestoreFamily='legacy'){if(this.restorePeerBusy(family))return;if(this.restoreCapability(family))await this.restoreControllerFor(family).stop(this.host);}
  async showRestoreOriginals(family:RestoreFamily='legacy'){if(this.restoreCapability(family))await this.restoreControllerFor(family).retained(this.host);}
  managementCurrentState(){const state=this.conversationManagement().view?.report?.current_state;return state==='live-original'?'Original conversation state still matches the preview':state==='desired-tombstones'?'Prepared logical removal is the current conversation state':state==='changed'?'Conversation state has changed since the preview':'Current state unverified';}
  managementHistoricalState(){const status=this.conversationManagement().view?.report?.status;return status==='acknowledged'?'Original logical-removal receipt verified':['ready','prepared'].includes(status??'')?'No removal has been confirmed':'Original historical outcome remains unproven';}
  managementPeerBusy(){return this.localModeChoice().busy||(this.settingsBusy()||this.handwritingRecords().busy)||(((this.settingsBusy()||this.handwritingRecords().busy)||this.archiveBusy())||this.restoresBusy())||this.conversationInventory().busy||(this.cacheInventory().busy||(this.ownedV3().busy||this.storageInitialization().busy))||this.cacheCleanup().busy||this.fileCredential().busy||this.credential().busy||this.memorySettings().busy||this.research().busy||this.model().busy||(this.settingsBusy()||this.basic().busy)||this.forget().busy||this.archiveExport().busy;}
  canManageConversation(action:'inspect'|'prepare'|'confirm'){if(!this.host.conversationManagement||!this.profile().inspection||(((this.settingsBusy()||this.handwritingRecords().busy)||this.archiveBusy())||this.restoresBusy())||this.conversationManagement().busy||this.managementPeerBusy())return false;const v=this.conversationManagement().view;return action==='inspect'?this.conversationInventory().view?.complete===true&&!!this.conversationInventory().view?.candidates?.includes(this.conversationManagement().selection)&&this.managementController.valid()&&this.conversationManagement().retained.length<8:action==='prepare'?v?.state==='inspected':v?.state==='ready';}
  async selectManagement(event:Event){if(this.managementPeerBusy()||this.conversationManagement().busy)return;const value=(event.target as HTMLSelectElement).value;const selected=this.conversationInventory().view?.complete&&this.conversationInventory().view?.candidates?.includes(value)?value:'';if(this.conversationManagement().view&&this.host.conversationManagement)await this.managementController.stop({conversationManagement:q=>this.host.conversationManagement!(q)});this.managementController.select(selected);}
  private clearManagementPeers(){this.clearPortable();this.handwritingController.clear();this.notebookController.clear();this.selectedController.clear();this.clearRestores();this.conversationController.clear();this.cleanupController.clear();this.storageInitializationController.clear();this.ownedV3Controller.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.clearSharedArchivePeers1();this.forgetController.clear();this.exportController.clear();this.savedConfigurationController.clear();}
  async manageConversation(action:'inspect'|'prepare'|'confirm'){const tablet=this.connection().observation;if(!tablet||!this.canManageConversation(action))return;this.clearManagementPeers();await this.managementController[action]({conversationManagement:q=>this.host.conversationManagement!(q)},tablet,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet&&this.profile().inspection;});}
  canCheckManagement(row:ManagementRetained){const t=this.connection().observation;return !!this.host.conversationManagement&&this.managementController.canCheck(row)&&!this.conversationManagement().busy&&!this.managementPeerBusy()&&!!t&&t.connection_id===row.connection_id&&t.boot_id===row.boot_id;}
  async checkManagement(row:ManagementRetained){const t=this.connection().observation;if(!t||!this.canCheckManagement(row))return;this.clearManagementPeers();await this.managementController.status({conversationManagement:q=>this.host.conversationManagement!(q)},t,row,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;});}
  async stopManagement(){if(this.managementPeerBusy())return;if(this.host.conversationManagement)await this.managementController.stop({conversationManagement:q=>this.host.conversationManagement!(q)});}
  async showManagementOriginals(){if(this.host.conversationManagement)await this.managementController.retained({conversationManagement:q=>this.host.conversationManagement!(q)});}
  cleanupPeerBusy(){return this.localModeChoice().busy||(this.settingsBusy()||this.handwritingRecords().busy)||(((this.settingsBusy()||this.handwritingRecords().busy)||this.archiveBusy())||this.restoresBusy())||this.conversationManagement().busy||this.conversationInventory().busy||(this.cacheInventory().busy||(this.ownedV3().busy||this.storageInitialization().busy))||this.fileCredential().busy||this.credential().busy||this.memorySettings().busy||this.research().busy||this.model().busy||(this.settingsBusy()||this.basic().busy)||this.forget().busy||this.archiveExport().busy;}
  canPrepareCleanup(){return !!this.host.sourceCacheCleanup&&this.profile().inspection&&!this.cacheCleanup().busy&&!this.cleanupPeerBusy()&&this.cleanupController.valid()&&this.cacheCleanup().retained.length<8;}
  canConfirmCleanup(){return !!this.host.sourceCacheCleanup&&this.profile().inspection&&!this.cacheCleanup().busy&&!this.cleanupPeerBusy()&&this.cacheCleanup().view?.state==='ready';}
  selectCleanup(event:Event){this.cleanupController.select((event.target as HTMLInputElement).value);}
  private clearCleanupPeers(){this.clearPortable();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1();this.forgetController.clear();this.exportController.clear();this.savedConfigurationController.clear();}
  async prepareCleanup(){const tablet=this.connection().observation;if(!tablet||!this.canPrepareCleanup())return;this.clearCleanupPeers();await this.cleanupController.prepare({sourceCacheCleanup:q=>this.host.sourceCacheCleanup!(q)},tablet,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet&&this.profile().inspection;});}
  async confirmCleanup(){const tablet=this.connection().observation;if(!tablet||!this.canConfirmCleanup())return;this.clearCleanupPeers();await this.cleanupController.confirm({sourceCacheCleanup:q=>this.host.sourceCacheCleanup!(q)},tablet,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet&&this.profile().inspection;});}
  canCheckCleanup(row:CleanupRetained){const t=this.connection().observation;return !!this.host.sourceCacheCleanup&&this.cleanupController.canCheck(row)&&!this.cacheCleanup().busy&&!this.cleanupPeerBusy()&&!!t&&t.connection_id===row.connection_id&&t.boot_id===row.boot_id;}
  async checkCleanup(row:CleanupRetained){const tablet=this.connection().observation;if(!tablet||!this.canCheckCleanup(row))return;this.clearCleanupPeers();await this.cleanupController.status({sourceCacheCleanup:q=>this.host.sourceCacheCleanup!(q)},tablet,row,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet&&this.profile().inspection;});}
  async stopCleanup(){if(this.cleanupPeerBusy())return;if(this.host.sourceCacheCleanup)await this.cleanupController.stop({sourceCacheCleanup:q=>this.host.sourceCacheCleanup!(q)});else this.cleanupController.clear();}
  conversationPeerBusy(){return this.localModeChoice().busy||(this.settingsBusy()||this.handwritingRecords().busy)||(((this.settingsBusy()||this.handwritingRecords().busy)||this.archiveBusy())||this.restoresBusy())||this.conversationManagement().busy||(this.cacheInventory().busy||(this.ownedV3().busy||this.storageInitialization().busy))||this.cacheCleanup().busy||this.fileCredential().busy||this.credential().busy||this.memorySettings().busy||this.research().busy||this.model().busy||(this.settingsBusy()||this.basic().busy)||this.forget().busy||this.archiveExport().busy;}
  canInspectConversations(){return !!this.host.inspectConversations&&this.profile().inspection&&!this.conversationInventory().busy&&!this.conversationPeerBusy();}
  private clearConversationPeers(){this.clearPortable();this.handwritingController.clear();this.notebookController.clear();this.selectedController.clear();this.clearRestores();this.managementController.clear();this.cleanupController.clear();this.storageInitializationController.clear();this.ownedV3Controller.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.clearSharedArchivePeers1();this.forgetController.clear();this.exportController.clear();this.savedConfigurationController.clear();}
  async inspectConversations(){const tablet=this.connection().observation;if(!tablet||!this.canInspectConversations())return;this.clearConversationPeers();await this.conversationController.inspect({inspectConversations:q=>this.host.inspectConversations!(q)},tablet,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet&&this.profile().inspection;});}
  stopConversations(){this.conversationController.stop();}
  sourceCachePeerBusy(){return this.storageInitialization().busy||this.localModeChoice().busy||(this.settingsBusy()||this.handwritingRecords().busy)||(((this.settingsBusy()||this.handwritingRecords().busy)||this.archiveBusy())||this.restoresBusy())||this.conversationManagement().busy||this.conversationInventory().busy||this.cacheCleanup().busy||this.fileCredential().busy||this.credential().busy||this.memorySettings().busy||this.research().busy||this.model().busy||(this.settingsBusy()||this.basic().busy)||this.forget().busy||this.archiveExport().busy;}
  canInspectSourceCache(){return !!this.host.inspectSourceCache&&this.profile().inspection&&!this.archiveMaintenanceBusy2()&&!this.sourceCachePeerBusy();}
  private clearSourceCachePeers(){this.clearPortable();this.storageInitializationController.clear();this.ownedV3Controller.clear();this.handwritingController.clear();this.notebookController.clear();this.selectedController.clear();this.clearRestores();this.managementController.clear();this.conversationController.clear();this.cleanupController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.clearSharedArchivePeers1();this.forgetController.clear();this.exportController.clear();this.savedConfigurationController.clear();}
  async inspectSourceCache(){const tablet=this.connection().observation;if(!tablet||!this.canInspectSourceCache())return;this.clearSourceCachePeers();await this.cacheController.inspect({inspectSourceCache:q=>this.host.inspectSourceCache!(q)},tablet,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet&&this.profile().inspection;});}
  private storageInitializationAdapter(){return {storageInitialization:(q:import('../host/storage-initialization-protocol.mjs').StorageInitializationRequest)=>this.host.storageInitialization!(q)};}
  storageInitializationPeerBusy(){return this.sourceCachePeerBusy()||this.cacheInventory().busy||this.ownedV3().busy;}
  canBeginStorageInitialization(){const t=this.connection().observation;return !!this.host.storageInitialization&&this.profile().inspection&&!this.storageInitialization().busy&&!this.storageInitializationPeerBusy()&&!!t&&!this.storageInitialization().retained.some(r=>r.connection_id===t.connection_id&&r.outcome==='unknown');}
  async beginStorageInitialization(){const t=this.connection().observation;if(!t||!this.canBeginStorageInitialization())return;this.clearSourceCachePeers();this.cacheController.clear();this.savedModeController.clear();this.memoryInspectionController.clear();this.memoryController.clear();this.ownedController.clear();this.runtimeController.clear();this.personalizationController.clear();await this.storageInitializationController.begin(this.storageInitializationAdapter(),t,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;});}
  canConfirmStorageInitialization(){return this.canBeginStorageInitialization()&&this.storageInitialization().view?.state==='ready';}
  async confirmStorageInitialization(){const t=this.connection().observation;if(!t||!this.canConfirmStorageInitialization())return;this.notebookController.clear();await this.storageInitializationController.confirm(this.storageInitializationAdapter(),t,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;});}
  canCheckStorageInitialization(r:StorageInitializationRetained){const t=this.connection().observation;return !!this.host.storageInitialization&&!this.storageInitialization().busy&&!this.storageInitializationPeerBusy()&&!!t&&t.connection_id===r.connection_id&&t.boot_id===r.boot_id;}
  async checkStorageInitialization(r:StorageInitializationRetained){const t=this.connection().observation;if(!t||!this.canCheckStorageInitialization(r))return;this.clearSourceCachePeers();this.cacheController.clear();await this.storageInitializationController.refresh(this.storageInitializationAdapter(),t,r,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().inspection;});}
  stopStorageInitialization(){this.storageInitializationController.stop();}
  readonly storageModeKindLabels={'unconfigured':'Not set','local-only':'Local only','isolated-backup':'Isolated backup','shared-group':'Shared group'};
  canInspectOwnedV3(){return !!this.host.inspectOwnedV3&&this.profile().inspection&&!(this.ownedV3().busy||this.storageInitialization().busy)&&!this.cacheInventory().busy&&!this.sourceCachePeerBusy();}
  async inspectOwnedV3(){const tablet=this.connection().observation;if(!tablet||!this.canInspectOwnedV3())return;this.clearSourceCachePeers();this.cacheController.clear();this.ownedController.clear();this.runtimeController.clear();this.savedModeController.clear();this.memoryInspectionController.clear();this.memoryController.clear();this.personalizationController.clear();await this.ownedV3Controller.inspect({inspectOwnedV3:q=>this.host.inspectOwnedV3!(q)},tablet,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet&&this.profile().inspection;});}
  stopOwnedV3(){this.ownedV3Controller.stop();}
  stopSourceCache(){this.cacheController.stop();}
  fileCredentialPeerBusy(){return this.localModeChoice().busy||(this.settingsBusy()||this.handwritingRecords().busy)||this.archiveMaintenanceBusy2()||this.credential().busy||this.research().busy||this.memorySettings().busy||this.model().busy||(this.settingsBusy()||this.basic().busy)||this.forget().busy||this.archiveExport().busy;}
  canBeginFileCredential(){return !!this.host.modelCredential&&this.profile().savedConfigurationProbe&&!this.fileCredential().busy&&!this.fileCredentialPeerBusy()&&this.fileCredential().retained.length<8;}
  private clearFileCredentialPeers(){this.clearPortable();this.clearSharedArchivePeers2();this.credentialController.clear();this.researchController.clear();this.memorySettingsController.clear();this.exportController.clear();this.clearSharedArchivePeers1();this.forgetController.clear();this.savedConfigurationController.clear();}
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
  credentialPeerBusy(){return this.localModeChoice().busy||(this.settingsBusy()||this.handwritingRecords().busy)||this.archiveMaintenanceBusy2()||this.fileCredential().busy||this.research().busy||this.memorySettings().busy||this.model().busy||(this.settingsBusy()||this.basic().busy)||this.forget().busy||this.archiveExport().busy;}
  canBeginCredential(){return !!this.host.credentialReference&&this.profile().savedConfigurationProbe&&!this.fileCredential().busy&&!this.credential().busy&&!this.credentialPeerBusy();}
  private clearCredentialPeers(){this.clearPortable();this.clearSharedArchivePeers2();this.fileCredentialController.clear();this.researchController.clear();this.memorySettingsController.clear();this.exportController.clear();this.clearSharedArchivePeers1();this.forgetController.clear();this.savedConfigurationController.clear();}
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
  private memorySettingsPeerBusy(){return this.localModeChoice().busy||(this.settingsBusy()||this.handwritingRecords().busy)||this.archiveMaintenanceBusy2()||this.fileCredential().busy||this.credential().busy||this.research().busy||this.model().busy||(this.settingsBusy()||this.basic().busy)||this.forget().busy||this.archiveExport().busy;}
  async beginSavedMemory(){
    const tablet=this.connection().observation;if(!tablet||!this.profile().savedConfigurationProbe||!this.host.memorySettings||this.memorySettings().busy||this.memorySettingsPeerBusy())return;
    this.clearSharedArchivePeers2();this.fileCredentialController.clear();this.credentialController.clear();this.researchController.clear();this.exportController.clear();this.clearSharedArchivePeers1();this.forgetController.clear();this.savedConfigurationController.clear();
    await this.memorySettingsController.begin({memorySettings:q=>this.host.memorySettings!(q)},tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});
  }
  memorySettingAction(key:MemorySettingKey,event:Event){this.memorySettingsController.action(key,(event.target as HTMLSelectElement).value);}
  memoryEnabled(event:Event){this.memorySettingsController.enabled((event.target as HTMLSelectElement).value==='true');}
  memoryProfileText(){return this.memorySettingsController.text('profile');}
  beforeMemoryProfile(event:Event){const e=event as InputEvent,f=event.target as HTMLTextAreaElement;this.memorySettingsController.beforeInput('profile',f.selectionStart,f.selectionEnd,e.inputType,e.data);}
  inputMemoryProfile(event:Event){const f=event.target as HTMLTextAreaElement;this.memorySettingsController.input('profile',f.value);f.value=this.memoryProfileText();}
  pasteMemoryProfile(event:Event){const e=event as ClipboardEvent;if(!e.clipboardData)return;const f=event.target as HTMLTextAreaElement,text=e.clipboardData.getData('text/plain'),start=f.selectionStart;e.preventDefault();this.memorySettingsController.paste('profile',start,f.selectionEnd,text);f.value=this.memoryProfileText();const caret=Math.min(f.value.length,start+text.replace(/\r\n?/g,'\n').length);f.setSelectionRange(caret,caret);}
  async saveMemorySettings(){if(this.memorySettingsPeerBusy())return;this.clearSharedArchivePeers2();this.fileCredentialController.clear();this.credentialController.clear();this.researchController.clear();this.exportController.clear();this.clearSharedArchivePeers1();this.forgetController.clear();this.savedConfigurationController.clear();const tablet=this.connection().observation;if(tablet&&this.host.memorySettings)await this.memorySettingsController.save({memorySettings:q=>this.host.memorySettings!(q)},tablet);}
  async checkMemorySettings(record:MemorySettingsRetained){const tablet=this.connection().observation;if(!tablet||!this.host.memorySettings||this.memorySettingsPeerBusy())return;this.clearSharedArchivePeers2();this.fileCredentialController.clear();this.credentialController.clear();this.researchController.clear();this.exportController.clear();this.clearSharedArchivePeers1();this.forgetController.clear();await this.memorySettingsController.status({memorySettings:q=>this.host.memorySettings!(q)},record,tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});}
  canCheckMemorySettings(record:MemorySettingsRetained){const t=this.connection().observation;return !this.memorySettings().busy&&!this.memorySettingsPeerBusy()&&!!t&&t.connection_id===record.connection_id&&t.boot_id===record.boot_id;}
  async stopMemorySettings(){if(this.memorySettingsPeerBusy())return;if(this.host.memorySettings)await this.memorySettingsController.stop({memorySettings:q=>this.host.memorySettings!(q)});}
  exportText(){return this.exportController.text();}
  private portablePeersBusy(){return this.localModeChoice().busy||this.product().busy||this.basic().busy||this.model().busy||this.archiveExport().busy||this.cacheCleanup().busy||this.handwritingRecords().busy||this.notebookArchive().busy||this.selectedArchive().busy||this.restoresBusy()||this.conversationManagement().busy||this.conversationInventory().busy||this.storageInitialization().busy||this.ownedV3().busy||this.cacheInventory().busy||this.fileCredential().busy||this.credential().busy||this.memorySettings().busy||this.research().busy||this.forget().busy;}
  private clearPortablePeers(){this.sharedPreferenceController.clear();this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.notebookController.clear();this.selectedController.clear();this.restoreController.clear();this.notebookRestoreController.clear();this.managementController.clear();this.conversationController.clear();this.storageInitializationController.clear();this.ownedV3Controller.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.localModeController.clear();this.productController.clear();this.basicController.clear();this.modelController.clear();this.forgetController.clear();this.savedConfigurationController.clear();}
  portableAvailable(){return !this.sharedPreferences().busy&&!!this.host.portableConfiguration&&this.profile().savedConfigurationProbe&&!this.portablePeersBusy()&&!this.portable().busy;}
  canInspectSharedPreferences() {
    return !!this.host.sharedPreferences && this.profile().savedModeProbe &&
      !this.sharedPreferences().busy && !this.portable().busy && !this.portablePeersBusy();
  }

  async inspectSharedPreferences(reveal: boolean) {
    const observation = this.connection().observation, adapter = this.host.sharedPreferences;
    if (!adapter || !observation || !this.canInspectSharedPreferences()) return;
    this.portableController.clear();
    this.clearPortablePeers();
    await this.connectionController.pauseObservation();
    const current = () => this.connection().observation === observation;
    if (current()) await this.sharedPreferenceController.run(adapter,
      {action: 'inspect', ...sharedTarget(observation), reveal_text: reveal}, current);
  }

  async editSharedPreferences(event: Event) {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const observation = this.connection().observation, adapter = this.host.sharedPreferences;
    const {reference, view} = this.sharedPreferences();
    if (!adapter || !observation || !reference || !view || !this.canInspectSharedPreferences()) return;
    const values = new FormData(form);
    if (!values.has('confirm')) return;
    const patch = sharedPatch(values);
    const current = () => this.connection().observation === observation;
    await this.sharedPreferenceController.run(adapter,
      {action: 'edit', ...sharedTarget(observation), reference, patch}, current);
  }

  canCheckSharedPreference(record: RetainedPreference) {
    const observation = this.connection().observation;
    return this.canInspectSharedPreferences() && observation?.connection_id === record.connection_id &&
      observation.boot_id === record.boot_id;
  }

  async checkSharedPreference(reference: string) {
    const observation = this.connection().observation, adapter = this.host.sharedPreferences;
    if (!adapter || !observation || !this.canInspectSharedPreferences()) return;
    this.portableController.clear();
    this.clearPortablePeers();
    await this.connectionController.pauseObservation();
    const current = () => this.connection().observation === observation;
    if (current()) await this.sharedPreferenceController.run(adapter,
      {action: 'status', ...sharedTarget(observation), reference}, current);
  }

  async refreshSharedPreferenceOriginals() {
    if (this.host.sharedPreferences) {
      await this.sharedPreferenceController.run(this.host.sharedPreferences, {action: 'retained'});
    }
  }

  async stopSharedPreference() {
    const reference = this.sharedPreferences().reference;
    if (reference && this.host.sharedPreferences) {
      await this.sharedPreferenceController.run(this.host.sharedPreferences, {action: 'cancel', reference});
    } else {
      this.sharedPreferenceController.clear();
    }
  }

  async exportPortable(){const tablet=this.connection().observation;if(!tablet||!this.portableAvailable())return;this.clearPortablePeers();await this.portableController.read({portableConfiguration:q=>this.host.portableConfiguration!(q)},tablet,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet;});}
  async choosePortable(event:Event){const field=event.target as HTMLInputElement;let file:File|null=field.files?.length===1?field.files[0]:null;field.value='';const tablet=this.connection().observation;if(!file||!tablet||!this.portableAvailable())return;this.clearPortablePeers();const pending=this.portableController.read({portableConfiguration:q=>this.host.portableConfiguration!(q)},tablet,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet;},file);file=null;await pending;}
  async confirmPortable(){const tablet=this.connection().observation;if(!tablet||!this.portableAvailable())return;this.clearPortablePeers();await this.portableController.confirm({portableConfiguration:q=>this.host.portableConfiguration!(q)},tablet);}
  async statusPortable(r:PortableRetained){const tablet=this.connection().observation;if(!tablet||!this.portableAvailable()||tablet.connection_id!==r.connection_id||tablet.boot_id!==r.boot_id)return;this.clearPortablePeers();await this.portableController.status({portableConfiguration:q=>this.host.portableConfiguration!(q)},tablet,r,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet;});}
  async stopPortable(){if(this.host.portableConfiguration)await this.portableController.stop({portableConfiguration:q=>this.host.portableConfiguration!(q)});}
  canEditExport(){return !(((this.settingsBusy()||this.handwritingRecords().busy)||this.archiveBusy())||this.restoresBusy())&&!!this.host.ordinaryExport&&this.profile().savedConfigurationProbe&&!this.research().busy&&!this.fileCredential().busy&&!this.credential().busy&&!this.memorySettings().busy&&!this.archiveExport().busy&&!this.model().busy&&!(this.settingsBusy()||this.basic().busy)&&!this.forget().busy;}
  beginExportEdit(){if(this.canEditExport())void this.connectionController.pause();}
  beforeExportInput(event:Event){const e=event as InputEvent,field=event.target as HTMLTextAreaElement;this.exportController.beforeInput(field.selectionStart,field.selectionEnd,e.inputType,e.data);}
  inputExport(event:Event){const field=event.target as HTMLTextAreaElement;this.exportController.input(field.value);field.value=this.exportController.text();}
  pasteExport(event:Event){const e=event as ClipboardEvent;if(!e.clipboardData)return;const field=event.target as HTMLTextAreaElement,text=e.clipboardData.getData('text/plain'),start=field.selectionStart;e.preventDefault();this.exportController.paste(start,field.selectionEnd,text);field.value=this.exportController.text();const caret=Math.min(field.value.length,start+text.replace(/\r\n?/g,'\n').length);field.setSelectionRange(caret,caret);}
  async prepareExport(){if(this.archiveMaintenanceBusy1())return;const tablet=this.connection().observation;if(!tablet||!this.profile().savedConfigurationProbe||!this.host.ordinaryExport||this.archiveExport().busy)return;this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1();this.forgetController.clear();this.savedConfigurationController.clear();await this.exportController.prepare({ordinaryExport:q=>this.host.ordinaryExport!(q)},tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});}
  async confirmExport(){if(this.archiveMaintenanceBusy1())return;const tablet=this.connection().observation;if(tablet&&this.host.ordinaryExport){this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1();this.forgetController.clear();await this.exportController.confirm({ordinaryExport:q=>this.host.ordinaryExport!(q)},tablet);}}
  async checkExport(record:ExportRetained){if(this.archiveMaintenanceBusy1())return;const tablet=this.connection().observation;if(tablet&&this.host.ordinaryExport&&tablet.connection_id===record.connection_id&&tablet.boot_id===record.boot_id){this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1();this.forgetController.clear();await this.exportController.status({ordinaryExport:q=>this.host.ordinaryExport!(q)},tablet,record.reference,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});}}
  canCheckExport(record:ExportRetained){const tablet=this.connection().observation;return !(((this.settingsBusy()||this.handwritingRecords().busy)||this.archiveBusy())||this.restoresBusy())&&!this.archiveExport().busy&&!!tablet&&tablet.connection_id===record.connection_id&&tablet.boot_id===record.boot_id;}
  async stopExport(){if(this.archiveMaintenanceBusy1())return;if(this.host.ordinaryExport)await this.exportController.stop({ordinaryExport:q=>this.host.ordinaryExport!(q)});}
  private researchPeerBusy(){return this.localModeChoice().busy||(this.settingsBusy()||this.handwritingRecords().busy)||this.archiveMaintenanceBusy2()||this.fileCredential().busy||this.credential().busy||this.memorySettings().busy||this.model().busy||(this.settingsBusy()||this.basic().busy)||this.forget().busy||this.archiveExport().busy;}
  canBeginResearch(){return !!this.host.researchSettings&&this.profile().savedConfigurationProbe&&!this.research().busy&&!this.researchPeerBusy();}
  private clearResearchPeers(){this.clearPortable();this.clearSharedArchivePeers2();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.exportController.clear();this.clearSharedArchivePeers1();this.forgetController.clear();this.savedConfigurationController.clear();}
  private async pauseResearch(tablet:import('./observation').TabletObservation){await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;}
  async beginResearch(){const tablet=this.connection().observation;if(!tablet||!this.canBeginResearch())return;this.clearResearchPeers();await this.researchController.begin({researchSettings:q=>this.host.researchSettings!(q)},tablet,()=>this.pauseResearch(tablet));}
  researchChoice(event:Event){this.researchController.choose((event.target as HTMLSelectElement).value);}
  async saveResearch(){const tablet=this.connection().observation;if(!tablet||!this.host.researchSettings||this.researchPeerBusy())return;this.clearResearchPeers();await this.researchController.save({researchSettings:q=>this.host.researchSettings!(q)},tablet);}
  researchTarget(record:ResearchRetained){const tablet=this.connection().observation;return tablet?.connection_id===record.connection_id&&tablet.boot_id===record.boot_id;}
  async checkResearch(record:ResearchRetained){const tablet=this.connection().observation;if(!tablet||!this.host.researchSettings||this.researchPeerBusy())return;this.clearResearchPeers();await this.researchController.status({researchSettings:q=>this.host.researchSettings!(q)},record,tablet,()=>this.pauseResearch(tablet));}
  async stopResearch(){if(this.researchPeerBusy())return;if(this.host.researchSettings)await this.researchController.stop({researchSettings:q=>this.host.researchSettings!(q)});}
  async beginModel(){if(this.archiveMaintenanceBusy1())return;this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();
    const tablet=this.connection().observation;if(!tablet||!this.profile().savedConfigurationProbe||!this.host.modelSettings||this.model().busy)return;
    this.exportController.clear();this.clearSharedArchivePeers3();this.savedConfigurationController.clear();
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
  async saveModel(){if(this.archiveMaintenanceBusy1())return;this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();const tablet=this.connection().observation;if(tablet&&this.host.modelSettings){this.exportController.clear();this.clearSharedArchivePeers3();this.savedConfigurationController.clear();await this.modelController.save({modelSettings:q=>this.host.modelSettings!(q)},tablet);}}
  modelTarget(record:ModelRetained){const tablet=this.connection().observation;return tablet?.connection_id===record.connection_id&&tablet.boot_id===record.boot_id;}
  async checkModel(record:ModelRetained){if(this.archiveMaintenanceBusy1())return;this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();const tablet=this.connection().observation;if(tablet&&this.host.modelSettings){this.exportController.clear();this.clearSharedArchivePeers3();await this.modelController.status({modelSettings:q=>this.host.modelSettings!(q)},record,tablet);}}
  async stopModel(){if(this.archiveMaintenanceBusy1())return;if(this.host.modelSettings)await this.modelController.stop({modelSettings:q=>this.host.modelSettings!(q)},()=>this.connectionController.pause());}
  productPeerBusy(){return this.localModeChoice().busy||this.basic().busy||this.model().busy||this.archiveExport().busy||this.forget().busy||this.research().busy||this.memorySettings().busy||this.credential().busy||this.fileCredential().busy||(this.cacheInventory().busy||(this.ownedV3().busy||this.storageInitialization().busy))||this.cacheCleanup().busy||this.conversationInventory().busy||this.conversationManagement().busy||this.restoresBusy()||this.archiveBusy()||this.handwritingRecords().busy;}
  async beginProduct(){if(this.productPeerBusy())return;if(this.archiveMaintenanceBusy3())return;
    const tablet=this.connection().observation;if(!tablet||!this.profile().savedConfigurationProbe||!this.host.productSettings||this.settingsBusy())return;
    this.localModeController.clear();this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.modelController.clear();this.basicController.clear();this.forgetController.clear();this.savedConfigurationController.clear();
    await this.productController.begin({productSettings:q=>this.host.productSettings!(q)},tablet,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});
  }
  editProduct(key:ProductKey,event:Event){this.productController.edit(key,(event.target as HTMLSelectElement).value);}
  clearProduct(key:ProductKey){this.productController.edit(key,'');}
  async saveProduct(){if(this.productPeerBusy())return;if(this.archiveMaintenanceBusy3())return;const tablet=this.connection().observation;if(tablet&&this.host.productSettings){this.localModeController.clear();this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.modelController.clear();this.basicController.clear();this.forgetController.clear();this.savedConfigurationController.clear();await this.productController.save({productSettings:q=>this.host.productSettings!(q)},tablet);}}
  productTarget(record:ProductRetained){const tablet=this.connection().observation;return tablet?.connection_id===record.connection_id&&tablet.boot_id===record.boot_id;}
  async checkProduct(record:ProductRetained){if(this.productPeerBusy())return;if(this.archiveMaintenanceBusy3())return;const tablet=this.connection().observation;if(tablet&&this.host.productSettings){this.localModeController.clear();this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.modelController.clear();this.basicController.clear();this.forgetController.clear();await this.productController.status({productSettings:q=>this.host.productSettings!(q)},record,tablet,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});}}
  async stopProduct(){if(this.productPeerBusy())return;if(this.archiveMaintenanceBusy3())return;if(this.host.productSettings)await this.productController.stop({productSettings:q=>this.host.productSettings!(q)},()=>this.connectionController.pauseObservation());}
  async beginBasic(){if(this.archiveMaintenanceBusy1())return;
    const tablet=this.connection().observation;if(!tablet||!this.profile().savedConfigurationProbe||!this.host.basicSettings||(this.settingsBusy()||this.basic().busy))return;
    this.localModeController.clear();this.productController.clear();this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.modelController.clear();this.forgetController.clear();this.savedConfigurationController.clear();
    await this.basicController.begin({basicSettings:q=>this.host.basicSettings!(q)},tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});
  }
  editBasic(key:BasicKey,event:Event){this.basicController.edit(key,(event.target as HTMLSelectElement).value);}
  clearBasic(key:BasicKey){this.basicController.edit(key,'');}
  async saveBasic(){if(this.archiveMaintenanceBusy1())return;const tablet=this.connection().observation;if(tablet&&this.host.basicSettings){this.localModeController.clear();this.productController.clear();this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.modelController.clear();this.forgetController.clear();this.savedConfigurationController.clear();await this.basicController.save({basicSettings:q=>this.host.basicSettings!(q)},tablet);}}
  basicTarget(record:BasicRetained){const tablet=this.connection().observation;return tablet?.connection_id===record.connection_id&&tablet.boot_id===record.boot_id;}
  async checkBasic(record:BasicRetained){if(this.archiveMaintenanceBusy1())return;const tablet=this.connection().observation;if(tablet&&this.host.basicSettings){this.localModeController.clear();this.productController.clear();this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.modelController.clear();this.forgetController.clear();await this.basicController.status({basicSettings:q=>this.host.basicSettings!(q)},record,tablet);}}
  async stopBasic(){if(this.archiveMaintenanceBusy1())return;if(this.host.basicSettings)await this.basicController.stop({basicSettings:q=>this.host.basicSettings!(q)},()=>this.connectionController.pause());}
  async prepareForget() {if(this.archiveMaintenanceBusy1())return;
    const tablet = this.connection().observation, head = this.forgetHead();
    if (!tablet || !head?.fact || !this.host.memoryForget || this.forget().busy) return;
    this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1();await this.connectionController.pause();
    if (this.connection().observation !== tablet || this.forgetHead() !== head) return;
    await this.forgetController.run({ memoryForget: request => this.host.memoryForget!(request) }, { action:'prepare', connection_id:tablet.connection_id, boot_id:tablet.boot_id, key:head.fact.key });
  }
  async forgetAction(action:'confirm'|'receipt'|'status') {if(this.archiveMaintenanceBusy1())return;
    if (!this.host.memoryForget) return;
    const reference = this.forget().reference;
    if (action !== 'status' && !reference) return;
    this.localModeController.clear();this.productController.clear();this.clearSharedArchivePeers2();this.fileCredentialController.clear();if(action!=='status'){this.exportController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.modelController.clear();this.basicController.clear();}
    if (action === 'confirm') this.memoryInspectionController.clear('Current data unverified after possible confirmation dispatch');
    await this.forgetController.run({ memoryForget: request => this.host.memoryForget!(request) }, action === 'status' ? { action } : { action, reference:reference! });
  }
  async stopForget() {if(this.archiveMaintenanceBusy1())return;
    await this.forgetController.stop(this.host.memoryForget ? { memoryForget: request => this.host.memoryForget!(request) } : null, () => this.host.cancel());
  }
  async inspectSavedConfiguration(){if(this.archiveMaintenanceBusy2())return;
    const tablet=this.connection().observation;
    if(!tablet||!this.profile().savedConfigurationProbe||!this.host.inspectSavedConfiguration||this.savedConfiguration().busy)return;
    this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1(); this.forgetController.clear();
    await this.savedConfigurationController.inspect({inspectSavedConfiguration:q=>this.host.inspectSavedConfiguration!(q)},tablet,async()=>{
      await this.connectionController.pause();
      return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;
    });
  }
  async cancelSavedConfiguration(){
    this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1(); this.forgetController.clear();
    await this.savedConfigurationController.cancel(()=>this.connectionController.pause());
  }
  readonly localModeLabels={'unconfigured':'Not set','local-only':'Local only','isolated-backup':'Separate cloud backup','shared-group':'Shared group'};
  readonly localModeOutcomeLabels={unknown:'Save not confirmed',acknowledged:'Saved',refused:'Not saved'};
  localModeHasUnconfirmed(){return this.localModeChoice().view?.state==='unknown'||this.localModeChoice().retained.some(r=>r.state==='unknown');}
  localModePeerBusy(){return this.product().busy||this.basic().busy||this.model().busy||this.archiveExport().busy||this.forget().busy||this.research().busy||this.memorySettings().busy||this.credential().busy||this.fileCredential().busy||(this.cacheInventory().busy||(this.ownedV3().busy||this.storageInitialization().busy))||this.cacheCleanup().busy||this.conversationInventory().busy||this.conversationManagement().busy||this.restoresBusy()||this.archiveBusy()||this.handwritingRecords().busy;}
  private localModeAdapter(){return {localModeChoice:(q:import('../host/local-mode-choice-protocol.mjs').LocalModeRequest)=>this.host.localModeChoice!(q)};}
  private clearLocalModePeers(){this.clearPortable();this.savedModeController.clear();this.savedConfigurationController.clear();this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.modelController.clear();this.productController.clear();this.basicController.clear();this.forgetController.clear();this.memoryInspectionController.clear();this.memoryController.clear();this.ownedController.clear();this.personalizationController.clear();this.runtimeController.clear();}
  canBeginLocalMode(){return !!this.host.localModeChoice&&this.profile().savedModeProbe&&!this.localModeChoice().busy&&!this.localModePeerBusy();}
  canChooseLocalMode(){const t=this.connection().observation;return this.canBeginLocalMode()&&!!t&&this.localModeChoice().view?.state==='ready'&&!this.localModeChoice().retained.some(r=>r.connection_id===t.connection_id&&r.state==='unknown');}
  async beginLocalMode(){const t=this.connection().observation;if(!t||!this.canBeginLocalMode())return;this.clearLocalModePeers();await this.localModeController.begin(this.localModeAdapter(),t,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t&&this.profile().savedModeProbe;});}
  async chooseLocalMode(){const t=this.connection().observation;if(!t||!this.canChooseLocalMode())return;this.clearLocalModePeers();await this.localModeController.choose(this.localModeAdapter(),t);}
  canRefreshLocalMode(r:LocalModeRetained){const t=this.connection().observation;return this.canBeginLocalMode()&&!!t&&t.connection_id===r.connection_id&&t.boot_id===r.boot_id;}
  async refreshLocalMode(r:LocalModeRetained){const t=this.connection().observation;if(!t||!this.canRefreshLocalMode(r))return;this.clearLocalModePeers();await this.localModeController.refresh(this.localModeAdapter(),t,r,async()=>{await this.connectionController.pauseObservation();return this.connection().observation===t;});}
  async stopLocalMode(){if(this.host.localModeChoice&&!this.localModePeerBusy())await this.localModeController.stop(this.localModeAdapter(),()=>this.host.cancel());}
  private stopLocalModeOnLifecycle(){if(this.host.localModeChoice)void this.localModeController.stop(this.localModeAdapter(),()=>this.host.cancel());}
  async inspectSavedMode() {if(this.archiveMaintenanceBusy2())return;
    this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1(); this.forgetController.clear();
    const tablet = this.connection().observation;
    if (!tablet || !this.profile().savedModeProbe || !this.host.inspectSavedMode || this.savedMode().busy) return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || !this.profile().savedModeProbe) return;
    await this.savedModeController.inspect({ inspectSavedMode: request => this.host.inspectSavedMode!(request) }, tablet);
  }
  async cancelSavedMode() { this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1(); this.forgetController.clear(); this.savedModeController.clear('Saved mode inspection cancelled'); try { await this.host.cancel(); } catch { /* Pending view is already invalidated. */ } }
  async inspectOwned() {if(this.archiveMaintenanceBusy2())return;
    this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1(); this.forgetController.clear();
    const tablet = this.connection().observation;
    if (!this.profile().inspection || !tablet || this.owned().status === 'Inspecting owned data…') return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || !this.profile().inspection) return;
    await this.ownedController.inspect(this.host, tablet);
  }
  async inspectRuntime() {if(this.archiveMaintenanceBusy2())return;
    this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1(); this.forgetController.clear();
    const tablet = this.connection().observation;
    if (!tablet || !this.profile().runtimeIdentityProbe || !this.host.inspectRuntime || this.runtimeIdentity().status === 'Reading binary version…') return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || !this.profile().runtimeIdentityProbe) return;
    await this.runtimeController.inspect({ inspectRuntime: () => this.host.inspectRuntime!() }, tablet);
  }
  async personalize(operation: PersonalizationOperation) {if(this.archiveMaintenanceBusy2())return;
    this.exportController.clear();this.cleanupController.clear();this.handwritingController.clear();this.clearArchivePeers();this.clearSharedArchivePeers1(); this.forgetController.clear();
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
  ngOnDestroy() { this.clearPortable(); this.stopLocalModeOnLifecycle(); document.removeEventListener('visibilitychange',this.clearFileOnHidden); window.removeEventListener('pagehide',this.clearModelOnPageHide); this.savedConfigurationController.clear(); this.downloadController.dispose(); this.driveController.dispose(); this.releases.dispose(); this.managerReleases.dispose(); this.connectionController.dispose(); this.exportController.clear();this.cleanupController.dispose();this.handwritingController.dispose();this.notebookController.dispose();this.selectedController.dispose();this.restoreController.dispose();this.notebookRestoreController.dispose();this.managementController.dispose();this.conversationController.clear();this.storageInitializationController.clear();this.ownedV3Controller.clear();this.cacheController.clear();this.fileCredentialController.clear();this.credentialController.clear();this.memorySettingsController.clear();this.researchController.clear();this.clearSharedArchivePeers1(); this.forgetController.clear(); this.memoryInspectionController.clear(); this.savedModeController.clear(); this.memoryController.clear(); this.ownedController.clear(); this.personalizationController.clear(); this.runtimeController.clear(); }
}
