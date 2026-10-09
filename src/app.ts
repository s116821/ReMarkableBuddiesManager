import { Component, ChangeDetectionStrategy, OnDestroy, signal } from '@angular/core';
import { currentHost } from './host';
import { ConnectionController, CONNECTION_LABELS } from './observation';
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
  private readonly connectionController = new ConnectionController(this.host, state => this.connection.set(state));
  readonly connection = signal(this.connectionController.state);
  readonly blockers = INSTALL_BLOCKERS;
  private readonly releases = new ReleaseController(this.preferenceStorage(), state => this.release.set(state));
  readonly release = signal(this.releases.state);
  constructor() { this.releases.start(); }
  private preferenceStorage(): Storage | null { try { return window.localStorage; } catch { return null; } }
  connectTablet() { void this.connectionController.connect(); }
  disconnectTablet() { this.connectionController.disconnect(); }
  refresh() { void this.releases.refresh(); }
  chooseOfficial() { this.releases.chooseOfficial(); }
  ngOnDestroy() { this.releases.dispose(); this.connectionController.dispose(); }
}
