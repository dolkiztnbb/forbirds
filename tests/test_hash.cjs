const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
vm.runInThisContext(fs.readFileSync('public/sha256.js', 'utf8'));
const native = text => crypto.createHash('sha256').update(text).digest('hex');
for (const text of ['', 'abc', 'Привет 🐦', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(1000)]) {
  assert.equal(ForBirdsHash.hex(text), native(text));
}
for (let i = 0; i < 20; i++) {
  const prefix = crypto.randomBytes(32).toString('hex');
  const firstWord = ForBirdsHash.createPowHasher(prefix);
  for (const nonce of ['0', '9', '12345', '9007199254740990']) {
    assert.equal(firstWord(nonce), parseInt(native(prefix + ':' + nonce).slice(0, 8), 16));
  }
}
const challenge = { prefix: 'a'.repeat(64), difficulty: 13, expires_at: Math.floor(Date.now() / 1000) + 300 };
let solved;
const worker = {
  importScripts() {}, ForBirdsHash, performance, Date, Number, Error,
  self: { postMessage(data) { if (data.type === 'solved') solved = data; } },
};
vm.runInNewContext(fs.readFileSync('public/pow-worker.js', 'utf8'), worker);
worker.self.onmessage({ data: challenge });
assert.ok(solved, 'worker must solve');
assert.equal(parseInt(native(challenge.prefix + ':' + solved.nonce).slice(0, 8), 16) >>> (32 - challenge.difficulty), 0);
const errors = [];
worker.self.postMessage = data => { if (data.type === 'error') errors.push(data); };
worker.self.onmessage({ data: { ...challenge, difficulty: 25 } });
assert.equal(errors.pop().code, 'pow_difficulty');
worker.ForBirdsHash = { createPowHasher: () => () => 0xffffffff };
worker.self.onmessage({ data: { ...challenge, difficulty: 24, expires_at: 0 } });
assert.equal(errors.pop().code, 'pow_timeout');
console.log('SHA-256 vectors, optimized nonce hashing, worker proof and error codes: OK');
