import { Component, ChangeDetectionStrategy } from '@angular/core';
import { currentHost } from './host';
import buildInfo from './build-info.json';

@Component({
  selector: 'app-root', standalone: true, templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  readonly host = currentHost();
  readonly version = buildInfo.version;
}
