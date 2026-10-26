const fail = code => { throw new Error(code); };
// JSON.parse alone loses duplicate object members. Scan the same valid JSON first.
export function strictJson(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  let i = 0;
  const space = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    fail('invalid-json');
  };
  function scan(depth = 0) {
    if (depth > 32) fail('json-depth');
    space();
    if (text[i] === '{') {
      i++; space(); const keys = new Set();
      if (text[i] === '}') { i++; return; }
      while (true) {
        space(); const key = string();
        if (keys.has(key)) fail('duplicate-json-member');
        keys.add(key); space(); i++; scan(depth + 1); space();
        if (text[i++] === '}') return;
      }
    }
    if (text[i] === '[') {
      i++; space();
      if (text[i] === ']') { i++; return; }
      while (true) { scan(depth + 1); space(); if (text[i++] === ']') return; }
    }
    if (text[i] === '"') { string(); return; }
    while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
  }
  scan(); return value;
}

