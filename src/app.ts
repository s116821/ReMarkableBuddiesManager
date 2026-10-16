import { Component, ChangeDetectionStrategy, OnDestroy, signal, computed } from '@angular/core';
import { currentHost } from './host';
import { ConnectionController, CONNECTION_LABELS } from './observation';
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
  readonly version = buildInfo.version;
  readonly connectionLabels = CONNECTION_LABELS;
  private readonly ownedController = new OwnedDataController(state => this.owned.set(state));
  readonly owned = signal(this.ownedController.state);
  private readonly connectionController = new ConnectionController(this.host, state => { this.ownedController.clear(); this.connection.set(state); });
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
  constructor() { this.releases.start(); }
  private preferenceStorage(): Storage | null { try { return window.localStorage; } catch { return null; } }
  connectTablet() { void this.connectionController.connect(); }
  disconnectTablet() { this.connectionController.disconnect(); }
  async inspectOwned() {
    const tablet = this.connection().observation;
    if (!this.profile().inspection || !tablet || this.owned().status === 'Inspecting owned data…') return;
    await this.connectionController.pause();
    if (this.connection().observation !== tablet || !this.profile().inspection) return;
    await this.ownedController.inspect(this.host, tablet);
  }
  refresh() { void this.releases.refresh(); }
  chooseOfficial() { this.releases.chooseOfficial(); }
  ngOnDestroy() { this.releases.dispose(); this.connectionController.dispose(); this.ownedController.clear(); }
}
