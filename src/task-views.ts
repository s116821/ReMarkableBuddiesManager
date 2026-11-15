import {Component, ChangeDetectionStrategy, Input} from '@angular/core';
import type {App} from './app';

/** Lazy presentation only; all operation state and authority stay with App. */
@Component({selector: 'manager-task-views', standalone: true, templateUrl: './task-views.html', changeDetection: ChangeDetectionStrategy.OnPush})
export class TaskViews {
  @Input({required: true}) app!: App;
}
