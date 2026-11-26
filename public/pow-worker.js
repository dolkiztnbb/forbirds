'use strict';
importScripts('/sha256.js');
self.onmessage = ({ data: challenge }) => {
  try {
    if (!Number.isInteger(challenge.difficulty) || challenge.difficulty < 8 || challenge.difficulty > 24) {
      throw new Error('pow_difficulty');
    }
    const firstWord = ForBirdsHash.createPowHasher(challenge.prefix);
    const start = performance.now();
    let lastProgress = start - 250;
    for (let nonce = 0; nonce < Number.MAX_SAFE_INTEGER; nonce++) {
      if ((firstWord(String(nonce)) >>> (32 - challenge.difficulty)) === 0) {
        self.postMessage({ type: 'solved', nonce: String(nonce), attempts: nonce + 1 });
        return;
      }
      if (nonce % 8192 === 0) {
        if (Date.now() >= challenge.expires_at * 1000 || performance.now() - start > 120000) {
          throw new Error('pow_timeout');
        }
        if (performance.now() - lastProgress >= 250) {
          self.postMessage({ type: 'progress', attempts: nonce + 1 });
          lastProgress = performance.now();
        }
      }
    }
  } catch (error) {
    self.postMessage({ type: 'error', code: error.message });
  }
};
