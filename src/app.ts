import {MemorySettingsController} from './memory-settings';
import type {MemoryKey as MemorySettingKey,MemoryRetained as MemorySettingsRetained} from '../host/memory-settings-protocol.mjs';
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
  private readonly memorySettingsController=new MemorySettingsController(state=>this.memorySettings.set(state),key=>{if(!key||key==='profile')document.querySelectorAll<HTMLTextAreaElement>('#memory-settings-profile').forEach(field=>{field.value='';});});
  readonly memorySettings=signal(this.memorySettingsController.state);
  readonly memorySettingsCanSave=computed(()=>this.memorySettings().view?.state==='ready'&&!this.memorySettings().busy&&this.memorySettings().valid&&this.memorySettings().retained.length<8);
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
  private readonly connectionController = new ConnectionController(this.host, state => { this.savedConfigurationController.clear(); this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear(); this.memoryInspectionController.clear(); this.savedModeController.clear(); this.memoryController.clear(); this.ownedController.clear(); this.personalizationController.clear(); this.runtimeController.clear(); this.connection.set(state); });
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
  issues() { return Object.entries(this.owned().report?.issues ?? {}).map(([code, count]) => ({ label: code.replaceAll('-', ' '), count })); }
  bytes(value: number) { return `${new Intl.NumberFormat().format(value)} bytes`; }
  readonly blockers = INSTALL_BLOCKERS;
  private readonly releases = new ReleaseController(this.preferenceStorage(), state => this.release.set(state));
  readonly release = signal(this.releases.state);
  private readonly managerReleases = new ReleaseController(null, state => this.managerRelease.set(state), undefined, 'manager');
  readonly managerRelease = signal(this.managerReleases.state);
  private readonly clearModelOnPageHide=()=>{this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();};
  constructor() { if(this.host.memorySettings)void this.memorySettingsController.retained({memorySettings:q=>this.host.memorySettings!(q)}); window.addEventListener('pagehide',this.clearModelOnPageHide); if(this.host.ordinaryExport)void this.exportController.retained({ordinaryExport:q=>this.host.ordinaryExport!(q)}); if(this.host.modelSettings)void this.modelController.retained({modelSettings:q=>this.host.modelSettings!(q)}); if(this.host.basicSettings)void this.basicController.retained({basicSettings:q=>this.host.basicSettings!(q)}); if (this.host.memoryForget) void this.forgetController.run({ memoryForget: request => this.host.memoryForget!(request) }, { action:'status' }); this.releases.start(); this.managerReleases.start(); void this.driveController.load(); void this.downloadController.request({action: 'status'}); }
  private preferenceStorage(): Storage | null { try { return window.localStorage; } catch { return null; } }
  connectTablet() { void this.connectionController.connect(); }
  disconnectTablet() { this.connectionController.disconnect(); }
  editMemory(event: Event) { this.memoryText.set((event.target as HTMLTextAreaElement).value); }
  async searchMemory() {
    this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear(); this.memoryInspectionController.clear();
    const tablet = this.connection().observation;
    if (!tablet || !this.profile().memoryQueryProbe || !this.host.memoryQuery || !this.memoryTextValid()) return;
    await this.memoryController.search({ memoryQuery: request => this.host.memoryQuery!(request) }, tablet, this.memoryText());
  }
  async cancelMemory() { this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear(); this.memoryInspectionController.clear(); this.memoryController.clear('Search cancelled'); try { await this.host.cancel(); } catch { /* Already cleared; no late result is accepted. */ } }
  async inspectMemory(key: MemoryKey) {
    this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear();
    const tablet = this.connection().observation;
    const matches = this.memoryData()?.context.facts;
    if (!tablet || !this.profile().memoryInspectionProbe || !this.host.inspectMemory || this.memoryInspection().busy || !matches?.some(m => JSON.stringify(m.fact.key) === JSON.stringify(key))) return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || this.memoryData()?.context.facts !== matches) return;
    await this.memoryInspectionController.inspect({ inspectMemory: request => this.host.inspectMemory!(request) }, tablet, key);
  }
  async cancelMemoryInspection() { this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear(); this.memoryInspectionController.clear('Memory inspection cancelled'); try { await this.host.cancel(); } catch { /* Already invalidated. */ } }
  async beginSavedMemory(){
    const tablet=this.connection().observation;if(!tablet||!this.profile().savedConfigurationProbe||!this.host.memorySettings||this.memorySettings().busy||this.model().busy||this.basic().busy||this.forget().busy||this.archiveExport().busy)return;
    this.exportController.clear();this.modelController.clear();this.basicController.clear();this.forgetController.clear();this.savedConfigurationController.clear();
    await this.memorySettingsController.begin({memorySettings:q=>this.host.memorySettings!(q)},tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});
  }
  memorySettingAction(key:MemorySettingKey,event:Event){this.memorySettingsController.action(key,(event.target as HTMLSelectElement).value);}
  memoryEnabled(event:Event){this.memorySettingsController.enabled((event.target as HTMLSelectElement).value==='true');}
  memoryProfileText(){return this.memorySettingsController.text('profile');}
  beforeMemoryProfile(event:Event){const e=event as InputEvent,f=event.target as HTMLTextAreaElement;this.memorySettingsController.beforeInput('profile',f.selectionStart,f.selectionEnd,e.inputType,e.data);}
  inputMemoryProfile(event:Event){const f=event.target as HTMLTextAreaElement;this.memorySettingsController.input('profile',f.value);f.value=this.memoryProfileText();}
  pasteMemoryProfile(event:Event){const e=event as ClipboardEvent;if(!e.clipboardData)return;const f=event.target as HTMLTextAreaElement,text=e.clipboardData.getData('text/plain'),start=f.selectionStart;e.preventDefault();this.memorySettingsController.paste('profile',start,f.selectionEnd,text);f.value=this.memoryProfileText();const caret=Math.min(f.value.length,start+text.replace(/\r\n?/g,'\n').length);f.setSelectionRange(caret,caret);}
  async saveMemorySettings(){const tablet=this.connection().observation;if(tablet&&this.host.memorySettings)await this.memorySettingsController.save({memorySettings:q=>this.host.memorySettings!(q)},tablet);}
  async checkMemorySettings(record:MemorySettingsRetained){const tablet=this.connection().observation;if(!tablet||!this.host.memorySettings||this.model().busy||this.basic().busy||this.forget().busy||this.archiveExport().busy)return;this.exportController.clear();this.modelController.clear();this.basicController.clear();this.forgetController.clear();await this.memorySettingsController.status({memorySettings:q=>this.host.memorySettings!(q)},record,tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});}
  canCheckMemorySettings(record:MemorySettingsRetained){const t=this.connection().observation;return !this.memorySettings().busy&&!!t&&t.connection_id===record.connection_id&&t.boot_id===record.boot_id;}
  async stopMemorySettings(){if(this.host.memorySettings)await this.memorySettingsController.stop({memorySettings:q=>this.host.memorySettings!(q)});}
  exportText(){return this.exportController.text();}
  canEditExport(){return !!this.host.ordinaryExport&&this.profile().savedConfigurationProbe&&!this.archiveExport().busy&&!this.model().busy&&!this.basic().busy&&!this.forget().busy&&!this.memorySettings().busy;}
  beginExportEdit(){if(this.canEditExport())void this.connectionController.pause();}
  beforeExportInput(event:Event){const e=event as InputEvent,field=event.target as HTMLTextAreaElement;this.exportController.beforeInput(field.selectionStart,field.selectionEnd,e.inputType,e.data);}
  inputExport(event:Event){const field=event.target as HTMLTextAreaElement;this.exportController.input(field.value);field.value=this.exportController.text();}
  pasteExport(event:Event){const e=event as ClipboardEvent;if(!e.clipboardData)return;const field=event.target as HTMLTextAreaElement,text=e.clipboardData.getData('text/plain'),start=field.selectionStart;e.preventDefault();this.exportController.paste(start,field.selectionEnd,text);field.value=this.exportController.text();const caret=Math.min(field.value.length,start+text.replace(/\r\n?/g,'\n').length);field.setSelectionRange(caret,caret);}
  async prepareExport(){if(this.memorySettings().busy)return;this.memorySettingsController.clear();const tablet=this.connection().observation;if(!tablet||!this.profile().savedConfigurationProbe||!this.host.ordinaryExport||this.archiveExport().busy)return;this.modelController.clear();this.basicController.clear();this.forgetController.clear();this.savedConfigurationController.clear();await this.exportController.prepare({ordinaryExport:q=>this.host.ordinaryExport!(q)},tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});}
  async confirmExport(){if(this.memorySettings().busy)return;this.memorySettingsController.clear();const tablet=this.connection().observation;if(tablet&&this.host.ordinaryExport){this.modelController.clear();this.basicController.clear();this.forgetController.clear();await this.exportController.confirm({ordinaryExport:q=>this.host.ordinaryExport!(q)},tablet);}}
  async checkExport(record:ExportRetained){if(this.memorySettings().busy)return;this.memorySettingsController.clear();const tablet=this.connection().observation;if(tablet&&this.host.ordinaryExport&&tablet.connection_id===record.connection_id&&tablet.boot_id===record.boot_id){this.modelController.clear();this.basicController.clear();this.forgetController.clear();await this.exportController.status({ordinaryExport:q=>this.host.ordinaryExport!(q)},tablet,record.reference,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});}}
  canCheckExport(record:ExportRetained){const tablet=this.connection().observation;return !this.archiveExport().busy&&!!tablet&&tablet.connection_id===record.connection_id&&tablet.boot_id===record.boot_id;}
  async stopExport(){if(this.host.ordinaryExport)await this.exportController.stop({ordinaryExport:q=>this.host.ordinaryExport!(q)});}
  async beginModel(){if(this.memorySettings().busy)return;
    const tablet=this.connection().observation;if(!tablet||!this.profile().savedConfigurationProbe||!this.host.modelSettings||this.model().busy)return;
    this.memorySettingsController.clear();this.exportController.clear();this.basicController.clear();this.forgetController.clear();this.savedConfigurationController.clear();
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
  async saveModel(){if(this.memorySettings().busy)return;const tablet=this.connection().observation;if(tablet&&this.host.modelSettings){this.memorySettingsController.clear();this.exportController.clear();this.basicController.clear();this.forgetController.clear();this.savedConfigurationController.clear();await this.modelController.save({modelSettings:q=>this.host.modelSettings!(q)},tablet);}}
  modelTarget(record:ModelRetained){const tablet=this.connection().observation;return tablet?.connection_id===record.connection_id&&tablet.boot_id===record.boot_id;}
  async checkModel(record:ModelRetained){if(this.memorySettings().busy)return;const tablet=this.connection().observation;if(tablet&&this.host.modelSettings){this.memorySettingsController.clear();this.exportController.clear();this.basicController.clear();this.forgetController.clear();await this.modelController.status({modelSettings:q=>this.host.modelSettings!(q)},record,tablet);}}
  async stopModel(){if(this.host.modelSettings)await this.modelController.stop({modelSettings:q=>this.host.modelSettings!(q)},()=>this.connectionController.pause());}
  async beginBasic(){if(this.memorySettings().busy)return;
    const tablet=this.connection().observation;if(!tablet||!this.profile().savedConfigurationProbe||!this.host.basicSettings||this.basic().busy)return;
    this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.forgetController.clear();this.savedConfigurationController.clear();
    await this.basicController.begin({basicSettings:q=>this.host.basicSettings!(q)},tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});
  }
  editBasic(key:BasicKey,event:Event){this.basicController.edit(key,(event.target as HTMLSelectElement).value);}
  clearBasic(key:BasicKey){this.basicController.edit(key,'');}
  async saveBasic(){if(this.memorySettings().busy)return;const tablet=this.connection().observation;if(tablet&&this.host.basicSettings){this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.forgetController.clear();this.savedConfigurationController.clear();await this.basicController.save({basicSettings:q=>this.host.basicSettings!(q)},tablet);}}
  basicTarget(record:BasicRetained){const tablet=this.connection().observation;return tablet?.connection_id===record.connection_id&&tablet.boot_id===record.boot_id;}
  async checkBasic(record:BasicRetained){if(this.memorySettings().busy)return;const tablet=this.connection().observation;if(tablet&&this.host.basicSettings){this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.forgetController.clear();await this.basicController.status({basicSettings:q=>this.host.basicSettings!(q)},record,tablet);}}
  async stopBasic(){if(this.host.basicSettings)await this.basicController.stop({basicSettings:q=>this.host.basicSettings!(q)},()=>this.connectionController.pause());}
  async prepareForget() {if(this.memorySettings().busy)return;
    const tablet = this.connection().observation, head = this.forgetHead();
    if (!tablet || !head?.fact || !this.host.memoryForget || this.forget().busy) return;
    this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear();await this.connectionController.pause();
    if (this.connection().observation !== tablet || this.forgetHead() !== head) return;
    await this.forgetController.run({ memoryForget: request => this.host.memoryForget!(request) }, { action:'prepare', connection_id:tablet.connection_id, boot_id:tablet.boot_id, key:head.fact.key });
  }
  async forgetAction(action:'confirm'|'receipt'|'status') {if(this.memorySettings().busy)return;
    if (!this.host.memoryForget) return;
    const reference = this.forget().reference;
    if (action !== 'status' && !reference) return;
    if(action!=='status'){this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear();}
    if (action === 'confirm') this.memoryInspectionController.clear('Current data unverified after possible confirmation dispatch');
    await this.forgetController.run({ memoryForget: request => this.host.memoryForget!(request) }, action === 'status' ? { action } : { action, reference:reference! });
  }
  async stopForget() {
    await this.forgetController.stop(this.host.memoryForget ? { memoryForget: request => this.host.memoryForget!(request) } : null, () => this.host.cancel());
  }
  async inspectSavedConfiguration(){
    const tablet=this.connection().observation;
    if(!tablet||!this.profile().savedConfigurationProbe||!this.host.inspectSavedConfiguration||this.savedConfiguration().busy)return;
    this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear();
    await this.savedConfigurationController.inspect({inspectSavedConfiguration:q=>this.host.inspectSavedConfiguration!(q)},tablet,async()=>{
      await this.connectionController.pause();
      return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;
    });
  }
  async cancelSavedConfiguration(){
    this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear();
    await this.savedConfigurationController.cancel(()=>this.connectionController.pause());
  }
  async inspectSavedMode() {
    this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear();
    const tablet = this.connection().observation;
    if (!tablet || !this.profile().savedModeProbe || !this.host.inspectSavedMode || this.savedMode().busy) return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || !this.profile().savedModeProbe) return;
    await this.savedModeController.inspect({ inspectSavedMode: request => this.host.inspectSavedMode!(request) }, tablet);
  }
  async cancelSavedMode() { this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear(); this.savedModeController.clear('Saved mode inspection cancelled'); try { await this.host.cancel(); } catch { /* Pending view is already invalidated. */ } }
  async inspectOwned() {
    this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear();
    const tablet = this.connection().observation;
    if (!this.profile().inspection || !tablet || this.owned().status === 'Inspecting owned data…') return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || !this.profile().inspection) return;
    await this.ownedController.inspect(this.host, tablet);
  }
  async inspectRuntime() {
    this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear();
    const tablet = this.connection().observation;
    if (!tablet || !this.profile().runtimeIdentityProbe || !this.host.inspectRuntime || this.runtimeIdentity().status === 'Reading binary version…') return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || !this.profile().runtimeIdentityProbe) return;
    await this.runtimeController.inspect({ inspectRuntime: () => this.host.inspectRuntime!() }, tablet);
  }
  async personalize(operation: PersonalizationOperation) {
    this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear();
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
  ngOnDestroy() { window.removeEventListener('pagehide',this.clearModelOnPageHide); this.savedConfigurationController.clear(); this.downloadController.dispose(); this.driveController.dispose(); this.releases.dispose(); this.managerReleases.dispose(); this.connectionController.dispose(); this.memorySettingsController.clear();this.exportController.clear();this.modelController.clear();this.basicController.clear(); this.forgetController.clear(); this.memoryInspectionController.clear(); this.savedModeController.clear(); this.memoryController.clear(); this.ownedController.clear(); this.personalizationController.clear(); this.runtimeController.clear(); }
}
