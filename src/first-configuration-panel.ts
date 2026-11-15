import {ChangeDetectionStrategy, Component, effect, input, output, signal, untracked, type OnDestroy} from '@angular/core';
import type {FirstConfigTarget} from '../host/first-configuration-protocol.mjs';
import {FirstConfigurationController, type FirstConfigAdapter} from './first-configuration';

@Component({
  selector: 'app-first-configuration',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {'(window:pagehide)': 'discard()', '(document:visibilitychange)': 'visibility()'},
  template: `
    <div class="mb-4">
      <button class="ui-button ui-button-secondary mt-3" type="button" (click)="run('review')"
        [disabled]="!canRun() || unknown()">Review first configuration</button>
      <button class="ui-button ui-button-secondary mt-3" type="button" (click)="run('check')"
        [disabled]="!canRun()">Check current configuration</button>
      @if (state().reference) {
        <button class="ui-button ui-button-primary mt-3" type="button" (click)="run('create')"
          [disabled]="!canRun() || unknown()">Create default configuration</button>
      }
      @if (state().busy) {
        <button class="ui-button ui-button-secondary mt-3" type="button" (click)="stop()">Stop configuration wait</button>
      }
      <p class="mt-3" role="status" data-testid="first-configuration-status">{{ state().busy ? 'Waiting for configuration check…' : labels[state().status] }}</p>
      @if (state().current; as current) {
        <p class="text-sm" data-testid="first-configuration-current">{{ currentLabels[current] }}</p>
      }
      @for (row of state().retained; track row.reference) {
        @if (row.connection_id === tablet()?.connection_id && row.outcome === 'unknown') {
          <p class="ui-warning" data-testid="first-configuration-original">Earlier creation was not confirmed. Checking the current configuration does not change that outcome.</p>
        }
      }
    </div>
  `,
})
export class FirstConfigurationPanel implements OnDestroy {
  readonly tablet = input<FirstConfigTarget | null>(null);
  readonly invoke = input<FirstConfigAdapter>();
  readonly pause = input.required<() => Promise<boolean>>();
  readonly peerBusy = input(false);
  readonly blocked = output<boolean>();
  private destroyed = false;
  private readonly controller = new FirstConfigurationController(state => {
    if (!this.destroyed) {
      this.state.set(state);
      this.blocked.emit(state.current === 'missing' || state.current === 'blocked');
    }
  });
  readonly state = signal(this.controller.state);
  readonly labels = {
    none: '', ready: 'Review the target’s default settings before creating the first configuration.',
    checked: '', created: 'Default configuration created and verified.', present: 'The existing configuration was preserved.',
    blocked: 'Configuration creation was refused.', unknown: 'Configuration creation was not confirmed. Check the current configuration.',
    busy: 'Another tablet operation is in progress.', unavailable: 'First configuration requires a qualified Buddy installation and quiescent wired tablet.',
    invalidated: 'Configuration review ended.', capacity: 'The configuration operation history is full.',
  };
  readonly currentLabels = {
    missing: 'No saved configuration is present.', present: 'A valid saved configuration is present.',
    blocked: 'The configuration could not be safely admitted.',
  };

  constructor() {
    effect(() => {
      this.tablet();
      const invoke = this.invoke();
      untracked(() => {
        this.discard();
        if (invoke) void this.controller.retained(invoke);
      });
    });
  }

  canRun() { return !!this.invoke() && !!this.tablet() && !this.peerBusy() && !this.state().busy; }
  unknown() {
    const target = this.tablet();
    return this.state().status === 'unknown' ||
      this.state().retained.some(row => row.connection_id === target?.connection_id && row.outcome === 'unknown');
  }
  run(action: 'review' | 'create' | 'check') {
    const invoke = this.invoke(), tablet = this.tablet();
    if (invoke && tablet && this.canRun()) void this.controller.run(action, tablet, invoke, this.pause());
  }
  stop() { void this.controller.stop(); }
  discard() { this.controller.discard(); }
  visibility() { if (document.visibilityState === 'hidden') this.discard(); }
  ngOnDestroy() { this.destroyed = true; this.discard(); }
}
