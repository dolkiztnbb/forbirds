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
assert.ok(!fs.existsSync(root + 'ruffle.js.map'));
console.log('Pinned Ruffle runtime integrity, licenses and defensive sandbox configuration: OK');
