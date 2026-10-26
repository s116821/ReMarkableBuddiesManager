import {SourceCacheInventoryHost} from './source-cache-inventory.mjs';
import {parseSourceCacheRequest,parseSourceCacheResult} from './source-cache-inventory-protocol.mjs';
import {ModelCredentialHost} from './model-credential.mjs';
import {parseModelCredentialRequest,parseModelCredentialResult,modelCredentialContext} from './model-credential-protocol.mjs';
import {CredentialReferenceHost} from './credential-reference.mjs';
import {parseCredentialReferenceRequest,parseCredentialReferenceResult,credentialResponseContext} from './credential-reference-protocol.mjs';
import {ResearchSettingsHost} from './research-settings.mjs';
import {parseResearchSettingsRequest,parseResearchSettingsResult,researchResponseContext} from './research-settings-protocol.mjs';
import {OrdinaryExportHost} from './ordinary-export.mjs';
import {parseExportRequest,parseExportResult,exportResponseContext} from './ordinary-export-protocol.mjs';
import { ModelSettingsHost } from './model-settings.mjs';
import { parseModelSettingsRequest,parseModelSettingsResult,modelResponseContext } from './model-settings-protocol.mjs';
import {MemorySettingsHost} from './memory-settings.mjs';
import {parseMemorySettingsRequest,parseMemorySettingsResult,memoryResponseContext} from './memory-settings-protocol.mjs';
import { BasicSettingsHost } from './basic-settings.mjs';
import { MaintenanceIO } from './maintenance-io.mjs';
import { parseBasicSettingsRequest,parseBasicSettingsResult } from './basic-settings-protocol.mjs';
import { parseSavedConfigurationRequest, parseSavedConfigurationResult } from './saved-configuration.mjs';
import { MemoryForgetHost } from './memory-forget.mjs';
import { parseForgetRequest, parseForgetResult } from './memory-forget-protocol.mjs';
import { parseMemoryInspectionRequest, parseMemoryInspectionResult } from './memory-inspection.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WiredObserver } from './observer.mjs';
import { DriveAuth } from './drive-auth.mjs';
import { parsePersonalizationRequest } from './personalization.mjs';
import { ManagerDownloads } from './manager-downloads.mjs';
import { parseDownloadRequest } from './manager-download-protocol.mjs';
import { parseMemoryRequest } from './memory-query.mjs';
import { parseSavedModeRequest, parseSavedModeResult } from './saved-mode.mjs';
import { validateResult } from './observation-protocol.mjs';
import { DRIVE_ACTIONS } from './drive-protocol.mjs';

// The host starts this helper explicitly; it serves the built UI on one loopback origin.
export async function startHelper({ root, observer = new WiredObserver(), driveAuth = new DriveAuth(), downloads = new ManagerDownloads() }) {
  const io=new MaintenanceIO();let basic,model,archive,research,memorySettings,credential,modelCredential,sourceCache;
  const forget = new MemoryForgetHost({ observer,io,beforeIO:()=>{sourceCache?.invalidate();modelCredential?.invalidate();credential?.invalidate();memorySettings?.invalidate();research?.invalidate();basic?.invalidate();model?.invalidate();archive?.invalidate();} });
  basic=new BasicSettingsHost({observer,io,beforeIO:()=>{sourceCache?.invalidate();modelCredential?.invalidate();credential?.invalidate();memorySettings?.invalidate();research?.invalidate();forget.invalidate();model?.invalidate();archive?.invalidate();}});
  model=new ModelSettingsHost({observer,io,beforeIO:()=>{sourceCache?.invalidate();modelCredential?.invalidate();credential?.invalidate();memorySettings?.invalidate();research?.invalidate();forget.invalidate();basic.invalidate();archive?.invalidate();}});
  archive=new OrdinaryExportHost({observer,io,beforeIO:()=>{sourceCache?.invalidate();modelCredential?.invalidate();credential?.invalidate();memorySettings?.invalidate();research?.invalidate();forget.invalidate();basic.invalidate();model.invalidate();}});
  research=new ResearchSettingsHost({observer:observer,io,beforeIO:()=>{sourceCache?.invalidate();modelCredential?.invalidate();credential?.invalidate();memorySettings?.invalidate();forget.invalidate();basic.invalidate();model.invalidate();archive.invalidate();}});
  memorySettings=new MemorySettingsHost({observer:observer,io,beforeIO:()=>{sourceCache?.invalidate();modelCredential?.invalidate();credential?.invalidate();research.invalidate();forget.invalidate();basic.invalidate();model.invalidate();archive.invalidate();}});
  credential=new CredentialReferenceHost({observer:observer,io,beforeIO:()=>{sourceCache?.invalidate();modelCredential?.invalidate();memorySettings.invalidate();research.invalidate();forget.invalidate();basic.invalidate();model.invalidate();archive.invalidate();}});
  modelCredential=new ModelCredentialHost({observer:observer,io,beforeIO:()=>{sourceCache?.invalidate();credential.invalidate();memorySettings.invalidate();research.invalidate();forget.invalidate();basic.invalidate();model.invalidate();archive.invalidate();}});
  sourceCache=new SourceCacheInventoryHost({observer:observer,io,beforeIO:()=>{modelCredential.invalidate();credential.invalidate();memorySettings.invalidate();research.invalidate();forget.invalidate();basic.invalidate();model.invalidate();archive.invalidate();}});
  observer = forget.wrap();
  const token = randomBytes(32).toString('hex');
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const refuse = code => { res.writeHead(code).end(); };
    if (req.headers.host !== new URL(origin).host) return refuse(403);
    const url = new URL(req.url, origin);
    if (url.pathname === '/manager-download') {
      if (url.search || req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' || req.headers.cookie !== `manager_session=${token}`) return refuse(403);
      let body = '', bytes = 0;
      try { for await (const chunk of req) { bytes += chunk.length; if (bytes > 192) return refuse(413); body += chunk; } } catch { return refuse(400); }
      let q; try { q = JSON.parse(body); if (body !== JSON.stringify(q)) throw new Error('Input'); parseDownloadRequest(q); } catch { return refuse(400); }
      try { const output = await downloads.request(q); res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(output)); } catch { refuse(409); }
      return;
    }
    if (req.method === 'GET' && req.headers['sec-fetch-dest'] === 'document' && req.headers['sec-fetch-mode'] === 'navigate' && ['/', '/preview/', '/preview/index.html'].includes(url.pathname)) observer.cancel();
    if(url.pathname==='/manager-ordinary-export'){
      if(url.search||req.method!=='POST'||req.headers.origin!==origin||req.headers['content-type']!=='application/json'||req.headers.cookie!==`manager_session=${token}`)return refuse(403);
      const chunks=[];let bytes=0,request;
      try{for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)return refuse(413);chunks.push(chunk);}const input=Buffer.concat(chunks);let raw;try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);}finally{input.fill(0);}request=JSON.parse(raw);if(raw!==JSON.stringify(request))throw Error('Input');parseExportRequest(request);}catch{return refuse(400);}finally{for(const chunk of chunks)chunk.fill(0);chunks.length=0;}
      try{const context=exportResponseContext(request),pending=archive.request(request);request=null;const value=parseExportResult(await pending,context,validateResult);archive.assertCurrent(value);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}catch{refuse(503);}finally{request=null;}return;
    }
    if(url.pathname==='/manager-research-settings'){
      if(url.search||req.method!=='POST'||req.headers.origin!==origin||req.headers['content-type']!=='application/json'||req.headers.cookie!==`manager_session=${token}`)return refuse(403);
      const chunks=[];let bytes=0,request;
      try{for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)return refuse(413);chunks.push(chunk);}const input=Buffer.concat(chunks);let raw;try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);}finally{input.fill(0);}request=JSON.parse(raw);if(raw!==JSON.stringify(request))throw Error('Input');parseResearchSettingsRequest(request);}catch{return refuse(400);}finally{for(const chunk of chunks)chunk.fill(0);chunks.length=0;}
      try{const context=researchResponseContext(request),pending=research.request(request);request=null;const value=parseResearchSettingsResult(await pending,context,validateResult);research.assertCurrent(value);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}catch{refuse(503);}finally{request=null;}return;
    }
    if(url.pathname==='/manager-memory-settings'){
      if(url.search||req.method!=='POST'||req.headers.origin!==origin||req.headers['content-type']!=='application/json'||req.headers.cookie!==`manager_session=${token}`)return refuse(403);
      const chunks=[];let bytes=0,request;
      try{for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)return refuse(413);chunks.push(chunk);}const input=Buffer.concat(chunks);let raw;try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);}finally{input.fill(0);}request=JSON.parse(raw);if(raw!==JSON.stringify(request))throw Error('Input');parseMemorySettingsRequest(request);}catch{return refuse(400);}finally{for(const chunk of chunks)chunk.fill(0);chunks.length=0;}
      try{const context=memoryResponseContext(request),pending=memorySettings.request(request);request=null;const value=parseMemorySettingsResult(await pending,context,validateResult);memorySettings.assertCurrent(value);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}catch{refuse(503);}finally{request=null;}return;
    }
    if(url.pathname==='/manager-source-cache-inventory'){
      if(url.search||req.method!=='POST'||req.headers.origin!==origin||req.headers['content-type']!=='application/json'||req.headers.cookie!==`manager_session=${token}`)return refuse(403);
      const chunks=[];let bytes=0,request;
      try{for await(const chunk of req){bytes+=chunk.length;if(bytes>256){chunk.fill(0);return refuse(413);}chunks.push(chunk);}const input=Buffer.concat(chunks);let raw;try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);}finally{input.fill(0);}request=JSON.parse(raw);if(raw!==JSON.stringify(request))throw Error('Input');parseSourceCacheRequest(request);}catch{return refuse(400);}finally{for(const chunk of chunks)chunk.fill(0);chunks.length=0;}
      try{const context=request,pending=sourceCache.request(request);request=null;const value=parseSourceCacheResult(await pending,context,validateResult);sourceCache.assertCurrent(value);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}catch{refuse(503);}finally{request=null;}return;
    }
    if(url.pathname==='/manager-model-credential'){
      if(url.search||req.method!=='POST'||req.headers.origin!==origin||req.headers['content-type']!=='application/json'||req.headers.cookie!==`manager_session=${token}`)return refuse(403);
      const chunks=[];let bytes=0,request;
      try{for await(const chunk of req){bytes+=chunk.length;if(bytes>16384){chunk.fill(0);return refuse(413);}chunks.push(chunk);}const input=Buffer.concat(chunks);let raw;try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);}finally{input.fill(0);}request=JSON.parse(raw);if(raw!==JSON.stringify(request))throw Error('Input');parseModelCredentialRequest(request);}catch{return refuse(400);}finally{for(const chunk of chunks)chunk.fill(0);chunks.length=0;}
      try{const context=modelCredentialContext(request),pending=modelCredential.request(request);request=null;const value=parseModelCredentialResult(await pending,context,validateResult);modelCredential.assertCurrent(value);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}catch{refuse(503);}finally{request=null;}return;
    }
    if(url.pathname==='/manager-credential-reference'){
      if(url.search||req.method!=='POST'||req.headers.origin!==origin||req.headers['content-type']!=='application/json'||req.headers.cookie!==`manager_session=${token}`)return refuse(403);
      const chunks=[];let bytes=0,request;
      try{for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)return refuse(413);chunks.push(chunk);}const input=Buffer.concat(chunks);let raw;try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);}finally{input.fill(0);}request=JSON.parse(raw);if(raw!==JSON.stringify(request))throw Error('Input');parseCredentialReferenceRequest(request);}catch{return refuse(400);}finally{for(const chunk of chunks)chunk.fill(0);chunks.length=0;}
      try{const context=credentialResponseContext(request),pending=credential.request(request);request=null;const value=parseCredentialReferenceResult(await pending,context,validateResult);credential.assertCurrent(value);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}catch{refuse(503);}finally{request=null;}return;
    }
    if(url.pathname==='/manager-model-settings'){
      if(url.search||req.method!=='POST'||req.headers.origin!==origin||req.headers['content-type']!=='application/json'||req.headers.cookie!==`manager_session=${token}`)return refuse(403);
      const chunks=[];let bytes=0,request;
      try{for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)return refuse(413);chunks.push(chunk);}const input=Buffer.concat(chunks);let raw;try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);}finally{input.fill(0);}request=JSON.parse(raw);if(raw!==JSON.stringify(request))throw Error('Input');parseModelSettingsRequest(request);}catch{return refuse(400);}finally{for(const chunk of chunks)chunk.fill(0);chunks.length=0;}
      try{const context=modelResponseContext(request),pending=model.request(request);request=null;const value=parseModelSettingsResult(await pending,context,validateResult);model.assertCurrent(value);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}catch{refuse(503);}finally{request=null;}return;
    }
    if(url.pathname==='/manager-basic-settings'){
      if(url.search||req.method!=='POST'||req.headers.origin!==origin||req.headers['content-type']!=='application/json'||req.headers.cookie!==`manager_session=${token}`)return refuse(403);
      const chunks=[];let bytes=0,request;
      try{for await(const chunk of req){bytes+=chunk.length;if(bytes>1024)return refuse(413);chunks.push(chunk);}const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));request=JSON.parse(raw);if(raw!==JSON.stringify(request))throw Error('Input');parseBasicSettingsRequest(request);}catch{return refuse(400);}
      try{const value=parseBasicSettingsResult(await basic.request(request),request,validateResult);basic.assertCurrent(value);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}catch{refuse(503);}return;
    }
    if (url.pathname === '/manager-memory-forget') {
      if (url.search || req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' || req.headers.cookie !== `manager_session=${token}`) return refuse(403);
      const chunks = []; let bytes = 0, request;
      try {
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 2048) return refuse(413); chunks.push(chunk); }
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        request = JSON.parse(raw); if (raw !== JSON.stringify(request)) throw new Error('Input'); parseForgetRequest(request);
      } catch { return refuse(400); }
      try {
        const value = await parseForgetResult(await forget.request(request), validateResult);
        forget.assertCurrent(value);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
      } catch { refuse(503); }
      return;
    }
    if (url.pathname === '/manager-memory-inspection') {
      if (url.search || req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' || req.headers.cookie !== `manager_session=${token}`) return refuse(403);
      const chunks = []; let bytes = 0, request;
      try {
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024) return refuse(413); chunks.push(chunk); }
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        request = JSON.parse(raw); if (raw !== JSON.stringify(request)) throw new Error('Input'); parseMemoryInspectionRequest(request);
      } catch { return refuse(400); }
      try {
        const value = await parseMemoryInspectionResult(await observer.inspectMemory(request), request, validateResult);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
      } catch { refuse(503); }
      return;
    }
    if (url.pathname === '/manager-saved-configuration') {
      if (url.search || req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' || req.headers.cookie !== `manager_session=${token}`) return refuse(403);
      const chunks=[];let bytes=0,request;
      try {
        for await(const chunk of req){bytes+=chunk.length;if(bytes>256)return refuse(413);chunks.push(chunk);}
        const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
        request=JSON.parse(raw);if(raw!==JSON.stringify(request))throw Error('Input');parseSavedConfigurationRequest(request);
      }catch{return refuse(400);}
      try {
        const pending=observer.inspectSavedConfiguration(request),generation=observer.generation;
        const value=parseSavedConfigurationResult(await pending,request,validateResult);
        if(generation!==observer.generation)throw Error('Inspection invalidated');
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));
      }catch{refuse(503);}
      return;
    }
    if (url.pathname === '/manager-saved-mode') {
      if (url.search || req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' || req.headers.cookie !== `manager_session=${token}`) return refuse(403);
      const chunks = []; let bytes = 0, request;
      try {
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 256) return refuse(413); chunks.push(chunk); }
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        request = JSON.parse(raw); if (raw !== JSON.stringify(request)) throw new Error('Input'); parseSavedModeRequest(request);
      } catch { return refuse(400); }
      try {
        const value = parseSavedModeResult(await observer.inspectSavedMode(request), request, validateResult);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
      } catch { refuse(503); }
      return;
    }
    if (url.pathname === '/manager-memory-query') {
      if (url.search || req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' || req.headers.cookie !== `manager_session=${token}`) return refuse(403);
      const chunks = []; let bytes = 0, request;
      try {
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) return refuse(413); chunks.push(chunk); }
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        request = JSON.parse(raw); if (raw !== JSON.stringify(request)) throw new Error('Input'); parseMemoryRequest(request);
      } catch { return refuse(400); }
      try { const value = await observer.memoryQuery(request); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); }
      catch { refuse(503); }
      return;
    }
    if (url.pathname === '/manager-personalization') {
      if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' || req.headers.cookie !== `manager_session=${token}`) return refuse(403);
      let body, bytes = 0; const chunks = [];
      try { for await (const chunk of req) { bytes += chunk.length; if (bytes > 131072) return refuse(413); chunks.push(chunk); } body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { return refuse(400); }
      let request;
      try { request = JSON.parse(body); if (body !== JSON.stringify(request)) throw new Error('Noncanonical input'); parsePersonalizationRequest(request); } catch { return refuse(400); }
      try { const value = await observer.personalization(request); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); }
      catch { refuse(503); }
      return;
    }
    if (url.pathname === '/manager-drive') {
      if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' || req.headers.cookie !== `manager_session=${token}`) return refuse(403);
      let body = '', bytes = 0;
      try { for await (const chunk of req) { bytes += chunk.length; if (bytes > 192) return refuse(413); body += chunk; } } catch { return refuse(400); }
      let value; try { value = JSON.parse(body); } catch { return refuse(400); }
      if (!value || body !== JSON.stringify(value) || !DRIVE_ACTIONS.includes(value.action) || Object.keys(value).sort().join() !== (value.action === 'revoke' ? 'action,authorizationId' : 'action') ||
          (value.action === 'revoke' && (typeof value.authorizationId !== 'string' || !/^[a-f0-9]{64}$/.test(value.authorizationId)))) return refuse(400);
      try {
        const output = value.action === 'revoke' ? await driveAuth.revoke(value.authorizationId) : await driveAuth[value.action]();
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(output));
      } catch { refuse(503); }
      return;
    }
    if (url.pathname === '/manager-host') {
      if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' ||
          req.headers.cookie !== `manager_session=${token}`) return refuse(403);
      let body = '', bytes = 0;
      try {
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 64) return refuse(413); body += chunk; }
      } catch { return refuse(400); }
      let value;
      try { value = JSON.parse(body); } catch { return refuse(400); }
      if (!value || typeof value !== 'object' || Object.keys(value).join() !== 'action' || !['identity', 'observe', 'cancel', 'inspect-owned', 'inspect-runtime'].includes(value.action)) return refuse(400);
      res.setHeader('Content-Type', 'application/json');
      const output = value.action === 'identity' ? { contract_version: 1, kind: 'browser', transport: 'wired-maintenance' } :
        value.action === 'cancel' ? observer.cancel() : value.action === 'inspect-runtime' ? await observer.inspectRuntime() : value.action === 'inspect-owned' ? await observer.inspectOwned() : await observer.observe();
      res.end(JSON.stringify(output)); return;
    }
    if (req.method !== 'GET' || !url.pathname.startsWith('/preview/')) return refuse(404);
    try {
      const relative = decodeURIComponent(url.pathname.slice('/preview/'.length)) || 'index.html';
      const file = path.resolve(root, relative);
      if (!file.startsWith(path.resolve(root) + path.sep) || !['.html', '.js', '.css', '.ico'].includes(path.extname(file))) return refuse(404);
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon' })[path.extname(file)]);
      if (relative === 'index.html') res.setHeader('Set-Cookie', `manager_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
      res.end(await readFile(file));
    } catch { refuse(404); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, server, close: async () => { observer.cancel(); driveAuth.dispose(); downloads.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
