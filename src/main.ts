import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app';

bootstrapApplication(App).catch(() => {
  document.body.textContent = 'Manager could not start. Please reload the application.';
});
