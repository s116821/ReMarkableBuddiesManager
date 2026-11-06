// Synthetic maintenance fixtures only. No producer, model or device contact.
import {initializationFixture,tablet,identity} from './storage-initialization.mjs';
import {addNotebookFixture} from './notebook-archive.mjs';
import {addNotebookRestoreFixture} from './notebook-restore.mjs';
export {tablet,identity};
export function notebookCompanionFixture(){
 const f=addNotebookRestoreFixture(addNotebookFixture(initializationFixture())),previous=f.observer.run;
 f.boundary={calls:0,gate:null};
 f.observer.run=async function(...args){f.boundary.calls++;const g=f.boundary.gate;if(g){g.entered=true;await g.promise;}return previous.apply(this,args);};
 return f;
}
