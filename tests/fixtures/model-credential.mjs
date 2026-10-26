import {credentialFixture} from './credential-reference.mjs';
export {tablet,defer,identity} from './model-settings.mjs';
export {report,rawReply} from './model-credential-base.mjs';
export const secret='SYNTHETIC_KEY\r\n tail α ';
export const modelCredentialFixture=(options={})=>credentialFixture({modelCredential:options});
export const begin=async f=>(await f.modelCredential.request({action:'begin',connection_id:f.observer.lastObservation.connection_id,boot_id:f.observer.lastObservation.boot_id})).model_credential.reference;
export const save=(f,reference,change={action:'install',value:secret})=>f.modelCredential.request({action:'save',connection_id:f.observer.lastObservation.connection_id,boot_id:f.observer.lastObservation.boot_id,reference,change});
