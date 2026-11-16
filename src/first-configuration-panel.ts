import {ChangeDetectionStrategy, Component, input} from '@angular/core';
import type {App} from './app';

@Component({
  selector: 'app-first-configuration',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-4">
      <button class="ui-button ui-button-secondary mt-3" type="button" (click)="run('review')"
        [disabled]="!canRun() || unknown()">Review first configuration</button>
      <button class="ui-button ui-button-secondary mt-3" type="button" (click)="run('check')"
        [disabled]="!canRun()">Check current configuration</button>
      @if (app().firstConfiguration().reference) {
        <button class="ui-button ui-button-primary mt-3" type="button" (click)="run('create')"
          [disabled]="!canRun() || unknown()">Create default configuration</button>
      }
      @if (app().firstConfiguration().busy) {
        <button class="ui-button ui-button-secondary mt-3" type="button" (click)="stop()">Stop configuration wait</button>
      }
      <p class="mt-3" role="status" data-testid="first-configuration-status">{{ app().firstConfiguration().busy ? 'Waiting for configuration check…' : labels[app().firstConfiguration().status] }}</p>
      @if (app().firstConfiguration().current; as current) {
        <p class="text-sm" data-testid="first-configuration-current">{{ currentLabels[current] }}</p>
      }
      @for (row of app().firstConfiguration().retained; track row.reference) {
        @if (row.connection_id === app().connection().observation?.connection_id && row.outcome === 'unknown') {
          <p class="ui-warning" data-testid="first-configuration-original">Earlier creation was not confirmed. Checking the current configuration does not change that outcome.</p>
        }
      }
    </div>
  `,
})
export class FirstConfigurationPanel {
  readonly app = input.required<App>();
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

  canRun() { return this.app().canRunFirstConfiguration(); }
  unknown() { return this.app().firstConfigurationUnknown(); }
  run(action: 'review' | 'create' | 'check') { this.app().runFirstConfiguration(action); }
  stop() { this.app().stopFirstConfiguration(); }
}
