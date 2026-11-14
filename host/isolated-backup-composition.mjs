import path from 'node:path';
import {DriveAuth} from './drive-auth.mjs';
import {DriveStore} from './drive-store.mjs';
import {IsolatedBackupDownload} from './isolated-backup-download.mjs';
import {IsolatedBackupHost} from './isolated-backup-host.mjs';
import {IsolatedBackupStaging} from './isolated-backup-staging.mjs';
import {IsolatedBackupVerifier} from './isolated-backup-verifier.mjs';

// Trusted host composition. Product entry points leave the read and stage
// inputs absent until the applicable installed and namespace qualification.
export function createIsolatedBackupComposition({hostRoot, store = new DriveStore(),
  backupReadFactory = null, stagingParent = null, excludedRoots = []}) {
  const driveAuth = new DriveAuth({store, backupReadFactory});
  const isolatedBackup = new IsolatedBackupHost({driveAuth});
  const coordinator = backupReadFactory && stagingParent ? new IsolatedBackupDownload({
    staging: new IsolatedBackupStaging({python: store.python, parent: stagingParent,
      excludedRoots: [store.root, ...excludedRoots]}),
    verifier: new IsolatedBackupVerifier({resourceRoot: path.join(hostRoot, 'buddy-oracle'), python: store.python}),
  }) : null;
  let closing;

  return Object.freeze({
    driveAuth,
    isolatedBackup,
    async downloadSelection(operation, reference) {
      const capture = isolatedBackup.captureDownload(operation, reference);
      if (!capture) return {status: 'invalidated', inspection: null, cleanupPending: false};
      if (!coordinator) return {status: 'unavailable', inspection: null, cleanupPending: false};
      return coordinator.download(capture);
    },
    dispose() {
      if (!closing) {
        const completion = Promise.withResolvers();
        closing = completion.promise;
        Promise.allSettled([isolatedBackup.dispose(), driveAuth.dispose(), coordinator?.dispose()])
          .then(results => {
            const failed = results.find(result => result.status === 'rejected');
            if (failed) completion.reject(failed.reason);
            else completion.resolve(results[2].value);
          });
      }
      return closing;
    },
  });
}
