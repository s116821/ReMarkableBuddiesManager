import {modelCredentialFixture} from './model-credential.mjs';
export {tablet,identity,defer,secret} from './model-credential.mjs';
export {document,inventoryReport,cacheRaw} from './source-cache-inventory-base.mjs';
export const sourceCacheFixture=(options={},fileOptions={})=>modelCredentialFixture({...fileOptions,sourceCache:options});
