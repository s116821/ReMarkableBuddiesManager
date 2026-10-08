import { Component, ChangeDetectionStrategy, OnDestroy, signal } from '@angular/core';
import { currentHost } from './host';
import buildInfo from './build-info.json';
import { INSTALL_BLOCKERS, ReleaseController } from './releases';

@Component({
  selector: 'app-root', standalone: true, templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnDestroy {
  readonly host = currentHost();
  readonly version = buildInfo.version;
  readonly blockers = INSTALL_BLOCKERS;
  private readonly releases = new ReleaseController(this.preferenceStorage(), state => this.release.set(state));
  readonly release = signal(this.releases.state);
  constructor() { this.releases.start(); }
  private preferenceStorage(): Storage | null { try { return window.localStorage; } catch { return null; } }
  refresh() { void this.releases.refresh(); }
  chooseOfficial() { this.releases.chooseOfficial(); }
  ngOnDestroy() { this.releases.dispose(); }
}
