import {memoryFixture} from './memory-settings.mjs';
export {identity,tablet,defer,name,hash,patchHash,report,rawReply,begin,save} from './credential-reference-base.mjs';
export const credentialFixture=(options={})=>memoryFixture({},options);
