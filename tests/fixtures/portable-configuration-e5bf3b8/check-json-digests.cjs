// Check actual producer bytes without rewriting them.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = process.argv[2];
const corpus = JSON.parse(fs.readFileSync(path.join(root, 'corpus.json'), 'utf8'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])]));
  return value;
}
function reversed(value) {
  if (Array.isArray(value)) return value.map(reversed);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).reverse().map(k => [k, reversed(value[k])]));
  return value;
}
const result = {node:process.version, source_contents_commit:corpus.source_contents_commit, artifacts:[]};
for (const item of corpus.artifacts) {
  const raw = fs.readFileSync(path.join(root,item.file));
  const value = JSON.parse(raw.toString('utf8'));
  const canonical = Buffer.from(JSON.stringify(ordered(reversed(value))),'utf8');
  assert.equal(sha(raw),item.producer_digest);
  assert.deepEqual(canonical,raw);
  result.artifacts.push({file:item.file, actual_rust_bytes_sha256:sha(raw), js_sorted_compact_sha256:sha(canonical),byte_equal:true});
}
for (const item of corpus.cases) {
  const raw = fs.readFileSync(path.join(root,'cases',item.name+'.stdout.bin'));
  const input = fs.readFileSync(path.join(root,'cases',item.name+'.stdin.bin'));
  const err = fs.readFileSync(path.join(root,'cases',item.name+'.stderr.bin'));
  assert.equal(sha(raw),item.stdout_sha256);
  assert.equal(sha(input),item.stdin_sha256);
  assert.equal(sha(err),item.stderr_sha256);
  assert.equal(Buffer.from(item.stdout_utf8,'utf8').compare(raw),0);
  assert.equal(Buffer.from(item.stdin_base64,'base64').compare(input),0);
}
result.original_cases_verified=corpus.cases.length;
console.log(JSON.stringify(result,null,2));
