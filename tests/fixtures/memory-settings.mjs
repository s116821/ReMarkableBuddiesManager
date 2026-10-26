// All maintenance integration fixtures compose the same six actual coordinators.
import {researchFixture} from './research-settings.mjs';
export {tablet,defer,identity,hash,profile,report,rawReply,patchHash,begin,save} from './memory-settings-base.mjs';
export const memoryFixture=(options={})=>researchFixture({},options);
