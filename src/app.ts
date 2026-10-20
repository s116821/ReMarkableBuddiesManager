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
  private readonly connectionController = new ConnectionController(this.host, state => { this.savedConfigurationController.clear(); this.basicController.clear(); this.forgetController.clear(); this.memoryInspectionController.clear(); this.savedModeController.clear(); this.memoryController.clear(); this.ownedController.clear(); this.personalizationController.clear(); this.runtimeController.clear(); this.connection.set(state); });
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
  constructor() { if(this.host.basicSettings)void this.basicController.retained({basicSettings:q=>this.host.basicSettings!(q)}); if (this.host.memoryForget) void this.forgetController.run({ memoryForget: request => this.host.memoryForget!(request) }, { action:'status' }); this.releases.start(); this.managerReleases.start(); void this.driveController.load(); void this.downloadController.request({action: 'status'}); }
  private preferenceStorage(): Storage | null { try { return window.localStorage; } catch { return null; } }
  connectTablet() { void this.connectionController.connect(); }
  disconnectTablet() { this.connectionController.disconnect(); }
  editMemory(event: Event) { this.memoryText.set((event.target as HTMLTextAreaElement).value); }
  async searchMemory() {
    this.basicController.clear(); this.forgetController.clear(); this.memoryInspectionController.clear();
    const tablet = this.connection().observation;
    if (!tablet || !this.profile().memoryQueryProbe || !this.host.memoryQuery || !this.memoryTextValid()) return;
    await this.memoryController.search({ memoryQuery: request => this.host.memoryQuery!(request) }, tablet, this.memoryText());
  }
  async cancelMemory() { this.basicController.clear(); this.forgetController.clear(); this.memoryInspectionController.clear(); this.memoryController.clear('Search cancelled'); try { await this.host.cancel(); } catch { /* Already cleared; no late result is accepted. */ } }
  async inspectMemory(key: MemoryKey) {
    this.basicController.clear(); this.forgetController.clear();
    const tablet = this.connection().observation;
    const matches = this.memoryData()?.context.facts;
    if (!tablet || !this.profile().memoryInspectionProbe || !this.host.inspectMemory || this.memoryInspection().busy || !matches?.some(m => JSON.stringify(m.fact.key) === JSON.stringify(key))) return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || this.memoryData()?.context.facts !== matches) return;
    await this.memoryInspectionController.inspect({ inspectMemory: request => this.host.inspectMemory!(request) }, tablet, key);
  }
  async cancelMemoryInspection() { this.basicController.clear(); this.forgetController.clear(); this.memoryInspectionController.clear('Memory inspection cancelled'); try { await this.host.cancel(); } catch { /* Already invalidated. */ } }
  async beginBasic(){
    const tablet=this.connection().observation;if(!tablet||!this.profile().savedConfigurationProbe||!this.host.basicSettings||this.basic().busy)return;
    this.forgetController.clear();this.savedConfigurationController.clear();
    await this.basicController.begin({basicSettings:q=>this.host.basicSettings!(q)},tablet,async()=>{await this.connectionController.pause();return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;});
  }
  editBasic(key:BasicKey,event:Event){this.basicController.edit(key,(event.target as HTMLSelectElement).value);}
  clearBasic(key:BasicKey){this.basicController.edit(key,'');}
  async saveBasic(){const tablet=this.connection().observation;if(tablet&&this.host.basicSettings){this.forgetController.clear();this.savedConfigurationController.clear();await this.basicController.save({basicSettings:q=>this.host.basicSettings!(q)},tablet);}}
  basicTarget(record:BasicRetained){const tablet=this.connection().observation;return tablet?.connection_id===record.connection_id&&tablet.boot_id===record.boot_id;}
  async checkBasic(record:BasicRetained){const tablet=this.connection().observation;if(tablet&&this.host.basicSettings){this.forgetController.clear();await this.basicController.status({basicSettings:q=>this.host.basicSettings!(q)},record,tablet);}}
  async stopBasic(){if(this.host.basicSettings)await this.basicController.stop({basicSettings:q=>this.host.basicSettings!(q)},()=>this.connectionController.pause());}
  async prepareForget() {
    const tablet = this.connection().observation, head = this.forgetHead();
    if (!tablet || !head?.fact || !this.host.memoryForget || this.forget().busy) return;
    this.basicController.clear();await this.connectionController.pause();
    if (this.connection().observation !== tablet || this.forgetHead() !== head) return;
    await this.forgetController.run({ memoryForget: request => this.host.memoryForget!(request) }, { action:'prepare', connection_id:tablet.connection_id, boot_id:tablet.boot_id, key:head.fact.key });
  }
  async forgetAction(action:'confirm'|'receipt'|'status') {
    if (!this.host.memoryForget) return;
    const reference = this.forget().reference;
    if (action !== 'status' && !reference) return;
    if(action!=='status')this.basicController.clear();
    if (action === 'confirm') this.memoryInspectionController.clear('Current data unverified after possible confirmation dispatch');
    await this.forgetController.run({ memoryForget: request => this.host.memoryForget!(request) }, action === 'status' ? { action } : { action, reference:reference! });
  }
  async stopForget() {
    await this.forgetController.stop(this.host.memoryForget ? { memoryForget: request => this.host.memoryForget!(request) } : null, () => this.host.cancel());
  }
  async inspectSavedConfiguration(){
    const tablet=this.connection().observation;
    if(!tablet||!this.profile().savedConfigurationProbe||!this.host.inspectSavedConfiguration||this.savedConfiguration().busy)return;
    this.basicController.clear(); this.forgetController.clear();
    await this.savedConfigurationController.inspect({inspectSavedConfiguration:q=>this.host.inspectSavedConfiguration!(q)},tablet,async()=>{
      await this.connectionController.pause();
      return this.connection().observation===tablet&&this.profile().savedConfigurationProbe;
    });
  }
  async cancelSavedConfiguration(){
    this.basicController.clear(); this.forgetController.clear();
    await this.savedConfigurationController.cancel(()=>this.connectionController.pause());
  }
  async inspectSavedMode() {
    this.basicController.clear(); this.forgetController.clear();
    const tablet = this.connection().observation;
    if (!tablet || !this.profile().savedModeProbe || !this.host.inspectSavedMode || this.savedMode().busy) return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || !this.profile().savedModeProbe) return;
    await this.savedModeController.inspect({ inspectSavedMode: request => this.host.inspectSavedMode!(request) }, tablet);
  }
  async cancelSavedMode() { this.basicController.clear(); this.forgetController.clear(); this.savedModeController.clear('Saved mode inspection cancelled'); try { await this.host.cancel(); } catch { /* Pending view is already invalidated. */ } }
  async inspectOwned() {
    this.basicController.clear(); this.forgetController.clear();
    const tablet = this.connection().observation;
    if (!this.profile().inspection || !tablet || this.owned().status === 'Inspecting owned data…') return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || !this.profile().inspection) return;
    await this.ownedController.inspect(this.host, tablet);
  }
  async inspectRuntime() {
    this.basicController.clear(); this.forgetController.clear();
    const tablet = this.connection().observation;
    if (!tablet || !this.profile().runtimeIdentityProbe || !this.host.inspectRuntime || this.runtimeIdentity().status === 'Reading binary version…') return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || !this.profile().runtimeIdentityProbe) return;
    await this.runtimeController.inspect({ inspectRuntime: () => this.host.inspectRuntime!() }, tablet);
  }
  async personalize(operation: PersonalizationOperation) {
    this.basicController.clear(); this.forgetController.clear();
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
  ngOnDestroy() { this.savedConfigurationController.clear(); this.downloadController.dispose(); this.driveController.dispose(); this.releases.dispose(); this.managerReleases.dispose(); this.connectionController.dispose(); this.basicController.clear(); this.forgetController.clear(); this.memoryInspectionController.clear(); this.savedModeController.clear(); this.memoryController.clear(); this.ownedController.clear(); this.personalizationController.clear(); this.runtimeController.clear(); }
}
