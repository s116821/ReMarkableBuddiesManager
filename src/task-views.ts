import {Component, ChangeDetectionStrategy, Input} from '@angular/core';
import type {App} from './app';
import {FirstConfigurationPanel} from './first-configuration-panel';

/** Lazy presentation only; all operation state and authority stay with App. */
@Component({selector: 'manager-task-views', standalone: true, imports: [FirstConfigurationPanel], templateUrl: './task-views.html', changeDetection: ChangeDetectionStrategy.OnPush})
export class TaskViews {
  @Input({required: true}) app!: App;
}
