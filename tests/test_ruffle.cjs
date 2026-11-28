const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const pkg = JSON.parse(fs.readFileSync('package.json'));
assert.equal(pkg.dependencies['@ruffle-rs/ruffle'], '0.8.0');
const root = 'public/vendor/ruffle/';
const manifest = fs.readFileSync(root + 'README.txt', 'utf8');
const hashes = [...manifest.matchAll(/^([a-f0-9]{64})  ([\w.-]+)$/gm)];
assert.equal(hashes.length, 5);
for (const [, hash, name] of hashes) {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(root + name)).digest('hex'), hash, name);
}
const frame = fs.readFileSync('public/flash-player.js', 'utf8');
for (const setting of ["allowScriptAccess: false", "allowNetworking: 'none'", "openUrlMode: 'deny'", 'credentialAllowList: []', 'event.source !== parent', 'event.origin !== parentOrigin']) assert.ok(frame.includes(setting), setting);
assert.ok(!frame.includes('allow-same-origin'));
const parentScript = fs.readFileSync('public/app.js', 'utf8');
for (const [, , name] of hashes.filter(([, , name]) => name.endsWith('.wasm'))) {
  assert.ok(frame.includes("'" + name + "'"), 'sandbox WASM allowlist matches pinned runtime');
  assert.ok(parentScript.includes("'" + name + "'"), 'parent WASM allowlist matches pinned runtime');
}
assert.ok(!fs.existsSync(root + 'ruffle.js.map'));
console.log('Pinned Ruffle runtime integrity, licenses and defensive sandbox configuration: OK');

// Exercise the sandbox's strictly bounded WASM bridge without loading Ruffle.
(async () => {
  const vm = require('node:vm');
  const listeners = [], sent = [];
  const parent = { postMessage: (message, origin) => sent.push({ message, origin }) };
  const window = { addEventListener: (type, handler) => { if (type === 'message') listeners.push(handler); } };
  const origin = 'https://forum.example';
  vm.runInNewContext(frame, { window, parent, location: { href: origin + '/flash-player.html' }, URL, ArrayBuffer, Response });
  for (const url of ['/api/session', 'https://evil.example/ruffle_web_bg.QDRSAAAZ.wasm', '/vendor/ruffle/unknown.wasm', '/vendor/ruffle/ruffle_web_bg.QDRSAAAZ.wasm?x=1']) {
    await assert.rejects(window.fetch(url), /Sandbox network disabled/);
  }
  assert.equal(sent.length, 0);
  const name = 'ruffle_web_bg.QDRSAAAZ.wasm';
  const response = window.fetch('/vendor/ruffle/' + name);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].origin, origin);
  assert.equal(sent[0].message.name, name);
  await assert.rejects(window.fetch('/vendor/ruffle/' + name), /Duplicate runtime request/);
  const data = { type: 'forbirds-flash-runtime', name, bytes: new ArrayBuffer(8) };
  // Untrusted senders/origins must not resolve or reject the pending response.
  listeners[0]({ source: {}, origin, data: { ...data, bytes: null } });
  listeners[0]({ source: parent, origin: 'https://evil.example', data: { ...data, bytes: null } });
  listeners[0]({ source: parent, origin, data });
  const result = await response;
  assert.equal(result.headers.get('Content-Type'), 'application/wasm');
  assert.equal((await result.arrayBuffer()).byteLength, 8);
  const invalid = window.fetch('/vendor/ruffle/' + name);
  listeners[0]({ source: parent, origin, data: { ...data, bytes: new ArrayBuffer(0) } });
  await assert.rejects(invalid, /Runtime unavailable/);
  console.log('Opaque sandbox WASM bridge: fixed paths, parent authentication, duplicate rejection, MIME and malformed payloads: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
