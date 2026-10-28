import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArchiveRequest, parseArchiveResult } from '../host/selected-archive-protocol.mjs';
import { parseArchiveRaw } from '../host/selected-archive-private.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
const vectors = JSON.parse(readFileSync(new URL('./fixtures/selected-archive-reference-vectors.json', import.meta.url)));
for (const [group, parse] of [
  ['raw_cases', c => parseArchiveRaw(c.stdout_hex ? Buffer.from(c.stdout_hex, 'hex') : Buffer.from(c.stdout_utf8), c.operation)],
  ['request_cases', c => parseArchiveRequest(c.request)],
  ['public_cases', c => parseArchiveResult(c.result, c.response_context ?? c.request, validateResult)]
]) test(`archive independent ${group}`, () => {
  for (const c of vectors[group]) {
    if (c.expect === 'accept') assert.doesNotThrow(() => parse(c), c.id);
    else assert.throws(() => parse(c), undefined, c.id);
  }
});
